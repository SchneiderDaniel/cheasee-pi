// ─── Pipeline Stages — core state machine ────────────────────────
// Stage transition logic: agent dispatch, marker matching, status
// resolution, built-in status handling, audit score tracking.
// The post-agent-success side effects (comments, git ops, auditor
// output) live in sibling modules (agent-comment, git-ops,
// auditor-output, post-agent-success).
// Reconstructed from the pre-split stages.ts (commit f6e2b10^).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	PipelineAgentResult,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { NotifyFn } from "../helpers.ts";
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
import { commitAndPush } from "../../github/git.ts";
import { extractAgentCommentBody, extractStructuredAuditOutput } from "../../agent/output.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { hasResearchFindings } from "../../config/workflow.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../../agent/output.ts";
import type { AgentOutput } from "../../config/types.ts";
import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import { buildDeadCodeContext as buildDeadCodeContextInner } from "../../checks/dead-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";

// ─── Constants ────────────────────────────────────────────────────

export const MAX_PIPELINE_LOOPS = 20;

// Bare-text fallback rules: maps agent names to the heading and regexes
// used when the agent output contains no JSON or structured heading.
type BareTextRule = {
	agent: string;
	heading: string;
	prefix: RegExp;
	word: RegExp;
};
const BARE_TEXT_RULES: readonly BareTextRule[] = [
	{ agent: "architect",     heading: "## Architecture",     prefix: /^Architecture[^a-zA-Z]/, word: /\bArchitecture\b/i },
	{ agent: "test-designer", heading: "## Test Plan",        prefix: /^Test\s*Plan[^a-zA-Z]/, word: /\bTest\s*Plan\b/i },
	{ agent: "researcher",    heading: "## Research Findings", prefix: /^Research[^a-zA-Z]/,    word: /\bResearch\b/i },
];

// ─── Stage State ──────────────────────────────────────────────────

/** Mutable state tracked across pipeline loop iterations. */
export interface StageState {
	loopStatus: string;
	lastAuditScore: AuditScore | null;
	auditCycleCount: number;
	/** Duplicate code check result, set during Implementation→Audit hooks */
	duplicateCodeResult: DuplicateCodeResult | null;
	/** Whether the researcher agent was skipped by the dedup gate */
	researcherSkipped: boolean;
	/** Dead code check result, set during Implementation→Audit hooks */
	deadCodeResult: DeadCodeResult | null;
	/** OSV vulnerability scan result, set during Implementation→Audit hooks */
	vulnResult: OsvScanResult | null;

	/**
	 * Gate failure note from the last pre-transition hook that returned
	 * effectiveNextStatus === "Implementation". Set by handler.ts after
	 * runTscAndLspAudit() returns a failure. Cleared on next successful
	 * transition to Audit. Ephemeral — lives only for this /supervisor
	 * command; does not persist across process restarts.
	 */
	gateFailureContext?: string;
	/**
	 * Accumulated gate failure history across ALL pipeline loop iterations.
	 * Each entry is a concise note identifying which pre-transition gate
	 * failed and on which developer run (e.g. "CI gate failed on run 1
	 * — developer restarted"). This array feeds into buildPipelineSummary
	 * for the PR body gate failure context section. Never truncated — all
	 * 3+ gate failures appear as separate entries.
	 */
	gateFailureHistory: string[];
	/**
	 * Files that conflicted in the last pre-Implementation rebase (issue
	 * #1473). Set on conflict, cleared on the next successful pre-dispatch
	 * rebase. Ephemeral — same lifecycle as gateFailureContext; survives
	 * Audit→Implementation loop-backs and feeds the developer task's
	 * "Reintegrate main" section and the PR summary.
	 */
	rebaseConflictFiles?: string[];
}

export function createStageState(initialStatus: string): StageState {
	return {
		loopStatus: initialStatus,
		lastAuditScore: null,
		auditCycleCount: 0,
		duplicateCodeResult: null,
		researcherSkipped: false,
		deadCodeResult: null,
		vulnResult: null,

		gateFailureContext: undefined,
		gateFailureHistory: [],
		rebaseConflictFiles: undefined,
	};
}

// ─── Built-in: Backlog ────────────────────────────────────────────

/**
 * Find a status option by field ID and name (case-insensitive).
 * Returns the option ID or null if not found.
 * Inlined from the removed findStatusOption in project.ts.
 */
function findOption(
	fields: ProjectField[],
	statusFieldId: string,
	statusName: string,
): string | null {
	const field = fields.find((f) => f.id === statusFieldId);
	if (!field?.options) return null;
	const option = field.options.find((o) => o.name.toLowerCase() === statusName.toLowerCase());
	return option?.id || null;
}

/**
 * Handle Backlog → Research transition.
 * Returns new status on success, throws with a message on failure.
 */
export async function handleBacklogTransition(
	port: GitHubPort,
	fields: ProjectField[],
	statusFieldId: string,
	itemId: string,
	projectId: string,
): Promise<string> {
	const optId = findOption(fields, statusFieldId, "Research");
	if (!optId) {
		throw new Error("Cannot find 'Research' status option");
	}
	try {
		await port.setItemStatusField(itemId, projectId, statusFieldId, optId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to set status: ${msg}`);
	}
	return "Research";
}

// ─── Built-in: Done ───────────────────────────────────────────────

export function isDoneStatus(loopStatus: string): boolean {
	return loopStatus.toLowerCase() === "done";
}

// ─── Agent Name Resolution ────────────────────────────────────────

export function resolveAgentName(loopStatus: string, config: SupervisorConfig): string | null {
	const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
	if (!step) return null;
	return step.agentName || config.statusMapping[loopStatus] || null;
}

// ─── Deduplication Gate ─────────────────────────────────────────────

/**
 * Check if the researcher agent should be skipped because research findings
 * already exist. This is a pipeline-level gate that replaces the LLM-instructed
 * deduplication scan that was previously in the researcher.md agent prompt.
 *
 * @returns true if researcher should be skipped
 */
export function shouldSkipResearcher(
	loopStatus: string,
	filteredData: { body: string; comments: Array<{ author: string; body: string }> },
): boolean {
	if (loopStatus !== "Research") return false;
	return hasResearchFindings(filteredData);
}

/**
 * Build a formatted string from DuplicateCodeResult for injection into auditor task context.
 * Returns null if no duplicates found or result is null.
 */
export function buildDuplicateCodeContext(result: DuplicateCodeResult | null): string | null {
	if (!result || result.status !== "duplicates_found" || result.clones.length === 0) return null;

	const lines: string[] = [];
	lines.push(
		`**${result.clones.length} clone(s) found (${result.totalDuplicateLines} total duplicate lines)**`,
	);
	lines.push("");

	for (let i = 0; i < result.clones.length; i++) {
		const clone = result.clones[i]!;
		lines.push(
			`Clone #${i + 1}: **${clone.type}** — ${clone.lines} lines, ${clone.similarity}% similarity`,
		);
		lines.push("Locations:");
		for (const loc of clone.locations) {
			lines.push(`  - \`${loc.file}\` lines ${loc.startLine}-${loc.endLine}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Build a formatted string from DeadCodeResult for injection into auditor task context.
 * Wraps the inner implementation from checks/dead-code.ts.
 * Returns null if no dead code found or result is null.
 */
export function buildDeadCodeContext(result: DeadCodeResult | null): string | null {
	return buildDeadCodeContextInner(result);
}

// ─── Vuln Context ─────────────────────────────────────────────────────

/**
 * Build a formatted string from OsvScanResult for injection into auditor task context.
 * Wraps the inner implementation from checks/osv-scanner.ts.
 */
export function buildVulnContext(result: OsvScanResult | null): string | null {
	if (!result) return null;
	return buildVulnContextInner(result);
}

import { buildVulnContext as buildVulnContextInner } from "../../checks/osv-scanner.ts";

// ─── Gate Failure Context ────────────────────────────────────────────

/**
 * Apply gate failure context to stage state based on next status.
 * When effectiveNextStatus is "Implementation", the gate failure note
 * is stored for injection into the developer task on the next iteration,
 * AND a concise run-numbered entry is pushed to gateFailureHistory for
 * PR body rendering.
 * When effectiveNextStatus is "Audit", stale context is cleared.
 * Non-Implementation/Audit statuses leave state unchanged.
 * Empty notes are treated as no-ops.
 *
 * The runNumber parameter (1-indexed loop iteration) is embedded in the
 * gateFailureHistory entry for PR body context (R2 requirement).
 * When note is non-empty and effectiveNextStatus is "Implementation",
 * the first gate name is extracted from the note (content between ---
 * markers) and a formatted entry is pushed.
 */
export function applyGateFailureContext(
	state: StageState,
	effectiveNextStatus: string,
	note: string,
	runNumber?: number,
): void {
	if (effectiveNextStatus === "Implementation" && note && note.trim().length > 0) {
		state.gateFailureContext = note;
		// Extract first gate name from note for concise PR body entry.
		// The note from audit.ts has sections with "--- Gate Name ---" headers.
		const gateName = extractFirstGateName(note);
		const runLabel = runNumber !== undefined ? `run ${runNumber}` : `?`;
		state.gateFailureHistory.push(`${gateName} gate failed on ${runLabel} — developer restarted`);
	} else if (effectiveNextStatus === "Audit") {
		state.gateFailureContext = undefined;
	}
	// Other statuses (e.g., "Done") — leave state unchanged
}

/**
 * Extract the first gate name from a combined gate failure note.
 * The note from audit.ts contains sections delimited by "--- Gate Name ---"
 * headers (e.g., "--- CI Gate ---", "--- TypeScript Checkpoint ---").
 * Returns the gate name if found, or "Pre-transition" as fallback.
 */
function extractFirstGateName(note: string): string {
	const gatePattern = /---\s*(.+?)\s*---/;
	const match = note.match(gatePattern);
	if (match && match[1]) {
		return match[1].trim();
	}
	return "Pre-transition";
}

// ─── Check Rejection Limit ────────────────────────────────────────

export function isRejectionLimitReached(
	comments: Array<{ body: string }>,
	stepMaxRejections?: number,
): boolean {
	if (!stepMaxRejections || stepMaxRejections <= 0) return false;
	const rejectionCount = comments.filter((c) => {
		const body = c.body || "";
		return /##\s*Audit\s*Rejected/i.test(body);
	}).length;
	return rejectionCount >= stepMaxRejections;
}

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

	// Fallback: old marker-based detection (for backward compatibility)
	const nextStatus = resolveNextStatus(step, textOnly) ?? resolveNextStatus(step, agentOutput);
	if (!nextStatus) {
		// Bug #643: Only infer forward status when agent succeeded.
		// A failed agent (0 tools, 0 tokens) should NOT advance the pipeline
		// via inferForwardStatus — that would bypass failure detection and
		// send the pipeline to the next stage (e.g., auditor) with empty work.
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
		if (agentName === "auditor") {
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
export function trackAuditScore(agentOutput: string, state: StageState, toolNames?: Set<string>): AuditScoreInfo | null {
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

// ─── Status Transition ────────────────────────────────────────────

/**
 * Transition the issue to the next status on the project board.
 * Returns the new effective status.
 */
export async function applyStatusTransition(
	port: GitHubPort,
	itemId: string,
	projectId: string,
	fields: ProjectField[],
	statusFieldId: string,
	targetStatus: string,
): Promise<string> {
	const optId = findOption(fields, statusFieldId, targetStatus);
	if (!optId) {
		throw new Error(`Cannot find '${targetStatus}' option on board.`);
	}
	await port.setItemStatusField(itemId, projectId, statusFieldId, optId);
	return targetStatus;
}

// ─── Build Agent Result Entry ─────────────────────────────────────

export function buildAgentResultEntry(
	result: AgentRunResult,
	usedRetry: boolean,
	model?: string,
): PipelineAgentResult {
	const statusLabel = !result.success ? "FAILED" : usedRetry ? "SUCCESS (after retry)" : "SUCCESS";

	return {
		agentName: result.agentName,
		status: statusLabel as PipelineAgentResult["status"],
		durationMs: result.durationMs,
		tokenCount: result.tokenCount,
		toolCount: result.toolCount,
		failedToolCount: result.failedToolCount ?? undefined,
		model,
		errorOutput: result.errorOutput || undefined,
	};
}

// ─── Researcher Output Validation ─────────────────────────────────

/**
 * Check if a researcher comment body has substantive findings or just empty
 * template headers (e.g. "### Best Practices\n- —").
 *
 * Returns the original commentBody if it has real content,
 * or a graceful degradation fallback message if it's empty headers only.
 */
export function validateResearcherFindings(commentBody: string): string {
	// Check for graceful degradation message already present
	if (commentBody.includes("No relevant results found")) {
		return commentBody;
	}

	// Check for value judgment skip message — return unchanged
	// Format: "## Research Findings — Research skipped: ..."
	if (commentBody.includes("Research skipped:")) {
		return commentBody;
	}

	// Split into non-empty lines, trim each
	const lines = commentBody
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	// Count substantive bullets: lines starting with "- " that have content
	// after the dash (not just "- —", "-", or empty dash variants)
	const bulletContent = lines.filter((l) => {
		if (!l.startsWith("- ") && l !== "-") return false;
		const content = l.startsWith("- ") ? l.slice(2).trim() : l.slice(1).trim();
		// Empty bullet or just em-dash
		if (content === "" || content === "—" || content === "-") return false;
		return true;
	});

	// Also count any non-header, non-empty lines that aren't just dashes
	// (e.g. potential freeform text)
	const nonHeaderNonEmpty = lines.filter((l) => {
		if (l.startsWith("#")) return false;
		if (l.startsWith("- ") || l === "-") return false;
		if (l === "—" || l.startsWith("—")) return false;
		return l.length > 0;
	});

	// If no substantive bullets and no substantive non-header text,
	// the research is empty — replace with graceful degradation message
	if (bulletContent.length === 0 && nonHeaderNonEmpty.length === 0) {
		return "## Research Findings — No relevant results found for this topic.";
	}

	return commentBody;
}