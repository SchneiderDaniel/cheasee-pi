// ─── Status Resolution + Audit Score Tracking ────────────────────
// Agent-output → next-status resolution and audit-score trend tracking.
// Split out of stages/core.ts (issue #2001); re-exported from there.
// StageState stays defined in core.ts (type-only import — no runtime cycle).

import {
	resolveNextStatus,
	resolveNextStatusFromAgentOutput,
	extractAuditScore,
	computeAuditScoreFromFindings,
	getActiveAuditDimensions,
	evaluateAuditScoreGate,
	type AuditScore,
	type WorkflowStep,
	WORKFLOW,
} from "../../config/workflow.ts";
import { extractStructuredAuditMarkers } from "../../agent/structured-audit.ts";
import {
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
	isRefused as isAgentOutputRefused,
} from "../../agent/output.ts";
import type { AgentOutput, RefusedOutput } from "../../config/types.ts";
import type { StageState } from "./core.ts";

// ─── Audit Gate Types ─────────────────────────────────────────────

/** Context for evaluating the audit score gate in calculateNextStatus */
export interface AuditGateContext {
	/** Whether the researcher agent was skipped */
	researcherSkipped: boolean;
	/** Score threshold ratio (0.0–1.0), from config */
	scoreThreshold: number;
}

/** Result of a rejected audit gate */
export interface GateRejected {
	score: AuditScore;
	required: number;
	total: number;
}

// ─── Determine Next Status ────────────────────────────────────────

export interface NextStatusResult {
	status: string | null;
	stopReason?: string;
	/**
	 * True when status came from structured JSON parsing or text marker matching.
	 * False when status is null (no status determined) or from inferForwardStatus
	 * (pipeline inference, not agent output).
	 * Used by handler.ts to determine if a failed agent's transition was driven
	 * by explicit agent output vs. pipeline inference.
	 */
	hadExplicitMarker: boolean;
	/**
	 * When the audit score gate rejects an auditor's APPROVED, this contains
	 * the computed score, required minimum, and total dimensions.
	 */
	gateRejected?: GateRejected;
	/**
	 * When the agent declined the task via the documented `refusal` field,
	 * this carries the structured refusal so the handler can post the note
	 * before stopping. A refusal is never a status transition.
	 */
	refusal?: RefusedOutput;
}

/**
 * Resolve next status from agent output.
 * Uses structured JSON parsing (parseAgentOutput) when possible,
 * falls back to text marker matching for backward compatibility.
 * Returns null if no status can be determined (pipeline should stop).
 *
 * @param agentName - Name of the agent that just ran
 * @param agentOutput - Raw agent output (for JSON parsing)
 * @param textOnly - Text-only output (for marker matching)
 * @param success - Whether the agent completed successfully. When false,
 *                  inferForwardStatus is skipped to prevent a failed
 *                  agent from advancing the pipeline (Bug #643 fix).
 * @param auditContext - Optional audit gate context. When provided and
 *                       agentName is "auditor" with action "APPROVED",
 *                       the score gate is evaluated. If below threshold,
 *                       status overridden to "Implementation".
 */
export function calculateNextStatus(
	agentName: string,
	agentOutput: string,
	textOnly: string,
	success: boolean = true,
	auditContext?: AuditGateContext,
	toolNames?: Set<string>,
): NextStatusResult {
	const step = WORKFLOW.find((s) => s.agentName === agentName);
	if (!step)
		return {
			status: null,
			stopReason: `No workflow step for agent '${agentName}'`,
			hadExplicitMarker: false,
		};

	// Phase 2: Try structured AgentOutput parsing first
	// Use agentOutput (raw text) for JSON parsing since textOnly strips JSON
	const structuredStatus = resolveNextStatusFromAgentOutput(step, agentOutput, toolNames);
	if (structuredStatus) {
		// Audit score gate: when auditor APPROVED but score below threshold,
		// override to Implementation and attach gate rejection details
		if (agentName === "auditor" && structuredStatus === "Done" && auditContext) {
			const parseResult = parseAgentOutput(agentOutput, toolNames);
			if (isAgentOutputSuccess(parseResult)) {
				const output = parseResult as AgentOutput;
				if (output.action === "APPROVED" && output.findings && output.findings.length > 0) {
					const dimensions = getActiveAuditDimensions(auditContext.researcherSkipped);
					const score = computeAuditScoreFromFindings(output.findings, dimensions);
					const gateResult = evaluateAuditScoreGate(score, auditContext.scoreThreshold);
					if (!gateResult.passes) {
						return {
							status: "Implementation",
							hadExplicitMarker: true,
							gateRejected: {
								score,
								required: gateResult.required,
								total: dimensions.length,
							},
						};
					}
				}
			}
		}

		return { status: structuredStatus, hadExplicitMarker: true };
	}

	// Refusal: the agent declined the task (documented `refusal` field).
	// A refusal is a deliberate stop — never a status transition, never a
	// loop-back. hadExplicitMarker: true keeps the Bug #711 failed-agent
	// guard from double-firing on the unnatural success=false + refusal case.
	// The extra parse runs only on the null-status path (resolveNextStatusFromAgentOutput
	// already parsed for success); refusal prose is not schema-validatable.
	const refusalParse = parseAgentOutput(agentOutput, toolNames);
	if (isAgentOutputRefused(refusalParse)) {
		return {
			status: null,
			stopReason: `Agent refused: ${refusalParse.refusal}`,
			hadExplicitMarker: true,
			refusal: refusalParse,
		};
	}

	// Fallback: old marker-based detection (for backward compatibility)
	const nextStatus = resolveNextStatus(step, textOnly) ?? resolveNextStatus(step, agentOutput);
	if (!nextStatus) {
		// Bug #643: Only infer forward status when agent succeeded.
		// A failed agent (0 tools, 0 tokens) should NOT advance the pipeline
		// via inferForwardStatus — that would bypass failure detection and
		// send the pipeline to the next phase (e.g., auditor) with empty work.
		if (!success) {
			return {
				status: null,
				stopReason: `Agent ${agentName} failed — no completion marker found and forward inference skipped`,
				hadExplicitMarker: false,
			};
		}
		// No marker found — try to infer forward status from step's markerMap
		// This handles cases where agent completed work but output lacks marker
		const inferredStatus = inferForwardStatus(step);
		if (inferredStatus) {
			return { status: inferredStatus, hadExplicitMarker: false };
		}
		// ponytail: auditor fallback — if auditor succeeded but output format
		// didn't match expected markers, default to APPROVED instead of
		// deadlocking the pipeline. The model likely approved but used wrong format.
		// Guard (bug #1698): NEVER default to Done when the output carries a
		// rejection. The comment side (extractStructuredAuditMarkers) uses pan-text
		// lastIndexOf and posts "## Audit Rejected" even for unparseable output;
		// the status side must use the SAME grammar, or a REJECTED audit loops over
		// to PR creation + issue close. A rejection is a rejection whether or not
		// the JSON parsed — rejection evidence beats the approval-by-default.
		if (agentName === "auditor") {
			const markerDecision = extractStructuredAuditMarkers(agentOutput);
			if (markerDecision?.decision === "REJECTED") {
				return { status: "Implementation", hadExplicitMarker: true };
			}
			if (markerDecision?.decision === "APPROVED") {
				return { status: "Done", hadExplicitMarker: true };
			}
			return { status: "Done", hadExplicitMarker: false };
		}
		return {
			status: null,
			stopReason: `No completion marker found in ${agentName} output`,
			hadExplicitMarker: false,
		};
	}
	return { status: nextStatus, hadExplicitMarker: true };
}

/**
 * Infer the forward status from a workflow step's markerMap.
 * Returns the first marker value whose key is a forward marker
 * (doesn't start with AUDIT or FEEDBACK). Returns null if
 * no forward marker exists (all markers are AUDIT/FEEDBACK)
 * or markerMap is empty.
 */
export function inferForwardStatus(step: WorkflowStep): string | null {
	if (!step.markerMap) return null;
	const entries = Object.entries(step.markerMap);
	// Prefer forward markers (keys without AUDIT_/FEEDBACK_ prefix)
	for (const [key, val] of entries) {
		if (!key.startsWith("AUDIT") && !key.startsWith("FEEDBACK")) {
			return val;
		}
	}
	// All markers are AUDIT/FEEDBACK — none matched, can't infer forward direction
	return null;
}

// ─── Branch Commit Check ────────────────────────────────────────────
export interface AuditScoreInfo {
	cycleCount: number;
	score: AuditScore;
	trend?: "improving" | "declining" | "stable";
}

/**
 * Track audit scores across pipeline iterations.
 * Returns the audit score info if a score marker is found, null otherwise.
 */
export function trackAuditScore(
	agentOutput: string,
	state: StageState,
	toolNames?: Set<string>,
): AuditScoreInfo | null {
	const currentAuditScore = extractAuditScore(agentOutput, toolNames);
	if (!currentAuditScore) return null;

	state.auditCycleCount++;

	let trend: "improving" | "declining" | "stable" | undefined;
	if (state.lastAuditScore && state.auditCycleCount > 1) {
		const diff = currentAuditScore.passing - state.lastAuditScore.passing;
		if (diff > 0) trend = "improving";
		else if (diff < 0) trend = "declining";
		else trend = "stable";
	}

	state.lastAuditScore = currentAuditScore;

	return {
		cycleCount: state.auditCycleCount,
		score: currentAuditScore,
		trend,
	};
}
