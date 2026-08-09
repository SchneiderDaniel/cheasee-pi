// ─── Workflow Config ──────────────────────────────────────────────
// Config-driven pipeline: define transitions as data, not code.

import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent/output.ts";
import type { AgentOutput, Finding, FilteredIssueData, ParseResult } from "./types.ts";

export interface WorkflowStep {
	/** Board status column name (must match config.statusMapping keys) */
	status: string;
	/** Agent .md name (omitted for built-in statuses like Backlog/Done) */
	agentName?: string;
	/** Map of output marker substrings → next status */
	markerMap?: Record<string, string>;
	/** Statuses this step can send back to (feedback loop) */
	canLoopBackTo?: string[];
	/** Hooks to run before transition */
	hooks?: ("tsc" | "lsp" | "ci" | "dup" | "trace")[];
	/** Max rejections before forcing human intervention */
	maxRejections?: number;
	/** Built-in handler */
	builtIn?: "backlog" | "done";
}

export const WORKFLOW: WorkflowStep[] = [
	// Built-in: Backlog → Research
	{ status: "Backlog", builtIn: "backlog" },

	// Research → Architecture (linear forward)
	{
		status: "Research",
		agentName: "researcher",
		markerMap: { RESEARCH_COMPLETE: "Architecture" },
	},

	// Architecture → TestDesign (or loop back to Research)
	{
		status: "Architecture",
		agentName: "architect",
		markerMap: {
			ARCHITECTURE_COMPLETE: "TestDesign",
			FEEDBACK_RESEARCH: "Research",
		},
		canLoopBackTo: ["Research"],
	},

	// TestDesign → Implementation
	{
		status: "TestDesign",
		agentName: "test-designer",
		markerMap: { TEST_PLAN_COMPLETE: "Implementation" },
	},

	// Implementation → Audit (with CI + TSC + LSP + duplicate code hooks)
	{
		status: "Implementation",
		agentName: "developer",
		markerMap: { IMPLEMENTATION_COMPLETE: "Audit" },
		hooks: ["ci", "tsc", "lsp", "dup", "trace"],
	},

	// Audit → Done (approve) or Implementation (reject/loop back)
	// Uses both AUDIT_DECISION (structured output) and standalone
	// AUDIT_APPROVED/AUDIT_REJECTED markers for backward compatibility.
	// AUDIT_DECISION is the canonical marker; standalone markers kept
	// for agents not yet updated to use structured output.
	{
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			"AUDIT_DECISION: APPROVED": "Done",
			"AUDIT_DECISION: REJECTED": "Implementation",
			AUDIT_APPROVED: "Done",
			AUDIT_REJECTED: "Implementation",
		},
		canLoopBackTo: ["Implementation"],
		maxRejections: 5,
	},

	// Built-in: Done → stop
	{ status: "Done", builtIn: "done" },
];

/**
 * Find the LATEST matching marker in agent output.
 * Last occurrence wins — enables feedback markers to override forward markers.
 * Kept for backward compatibility during transition.
 */
export function resolveNextStatus(step: WorkflowStep, agentOutput: string): string | null {
	if (!step.markerMap) return null;

	let bestStatus: string | null = null;
	let bestIdx = -1;
	for (const [marker, nextStatus] of Object.entries(step.markerMap)) {
		const idx = agentOutput.lastIndexOf(marker);
		if (idx > bestIdx) {
			bestIdx = idx;
			bestStatus = nextStatus;
		}
	}
	return bestStatus;
}

/**
 * Resolve next status from parsed AgentOutput.
 * Uses deterministic JSON parsing instead of text marker lookups.
 * Falls back to marker-based resolution if AgentOutput can't be parsed.
 */
export function resolveNextStatusFromAgentOutput(
	step: WorkflowStep,
	agentOutputText: string,
	toolNames?: Set<string>,
): string | null {
	if (!step.markerMap) return null;

	// Track whether structured JSON was found but couldn't map.
	// Used at the end to default APPROVED for audit COMPLETE action.
	let hadBareComplete = false;

	// Try structured JSON parsing first
	const parseResult = parseAgentOutput(agentOutputText, toolNames);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		const action = output.action;

		// targetStatus: explicit override — bypasses all markerMap filtering, action branches,
		// and text marker fallbacks. Agents use this to signal feedback loops (architect → Research)
		// or to target any valid workflow status directly.
		if (output.targetStatus && typeof output.targetStatus === "string") {
			const trimmed = output.targetStatus.trim();
			if (trimmed.length > 0) return trimmed;
		}

		// Map action to appropriate marker key in the step's markerMap
		if (action === "APPROVED") {
			// Look for approval markers
			if (step.markerMap["AUDIT_DECISION: APPROVED"])
				return step.markerMap["AUDIT_DECISION: APPROVED"];
			if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
		}

		if (action === "REJECTED") {
			// Look for rejection markers
			if (step.markerMap["AUDIT_DECISION: REJECTED"])
				return step.markerMap["AUDIT_DECISION: REJECTED"];
			if (step.markerMap["AUDIT_REJECTED"]) return step.markerMap["AUDIT_REJECTED"];
		}

		if (action === "COMPLETE") {
			// Look for agent completion markers — skip audit markers
			const completionMarkers = Object.keys(step.markerMap).filter(
				(m) => !m.startsWith("AUDIT") && !m.startsWith("FEEDBACK"),
			);
			// Return the first forward status
			for (const marker of completionMarkers) {
				const status = step.markerMap[marker];
				if (status) return status;
			}

			// Auditor with COMPLETE: infer APPROVED/REJECTED from findings.
			// The auditor's only forward paths are AUDIT-prefixed (filtered above).
			// When findings has critical/warning items, treat as REJECTED.
			// Empty findings or only suggestions → APPROVED.
			// CRITICAL: check for findings being present at all (even empty array),
			// not just non-empty, because findings: [] means no blockers.
			if (output.findings !== undefined && output.findings !== null) {
				const hasBlockers = output.findings.some(
					(f) => f.severity === "critical" || f.severity === "warning",
				);
				if (hasBlockers) {
					if (step.markerMap["AUDIT_DECISION: REJECTED"])
						return step.markerMap["AUDIT_DECISION: REJECTED"];
					if (step.markerMap["AUDIT_REJECTED"]) return step.markerMap["AUDIT_REJECTED"];
				} else {
					if (step.markerMap["AUDIT_DECISION: APPROVED"])
						return step.markerMap["AUDIT_DECISION: APPROVED"];
					if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
				}
			}

			// Fallback: check commentBody for approval/rejection heading
			if (output.commentBody) {
				if (output.commentBody.includes("## Audit Approved")) {
					if (step.markerMap["AUDIT_DECISION: APPROVED"])
						return step.markerMap["AUDIT_DECISION: APPROVED"];
					if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
				}
				if (output.commentBody.includes("## Audit Rejected")) {
					if (step.markerMap["AUDIT_DECISION: REJECTED"])
						return step.markerMap["AUDIT_DECISION: REJECTED"];
					if (step.markerMap["AUDIT_REJECTED"]) return step.markerMap["AUDIT_REJECTED"];
				}
			}

			// BARE COMPLETE: no findings, no commentBody.
			// The auditor used the generic template action instead of APPROVED/REJECTED.
			// Set flag so we can default to APPROVED at the end if all fallbacks fail.
			hadBareComplete = true;
		}

		// If we still couldn't map, fall through to marker fallback
	}

	// Fallback 2: section heading detection for ## Audit Approved / ## Audit Rejected
	// Matches the pattern used by extractStructuredAuditOutput in github/comment.ts
	// when agent outputs structured markdown without JSON or text markers.
	const approvedHeadingIdx = agentOutputText.lastIndexOf("## Audit Approved");
	const rejectedHeadingIdx = agentOutputText.lastIndexOf("## Audit Rejected");

	if (approvedHeadingIdx !== -1 || rejectedHeadingIdx !== -1) {
		if (approvedHeadingIdx > rejectedHeadingIdx) {
			// Most recent heading is approval
			if (step.markerMap["AUDIT_DECISION: APPROVED"])
				return step.markerMap["AUDIT_DECISION: APPROVED"];
			if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
		} else {
			// Most recent heading is rejection
			if (step.markerMap["AUDIT_DECISION: REJECTED"])
				return step.markerMap["AUDIT_DECISION: REJECTED"];
			if (step.markerMap["AUDIT_REJECTED"]) return step.markerMap["AUDIT_REJECTED"];
		}
	}

	// Fallback 3: use old marker-based detection
	const textResult = resolveNextStatus(step, agentOutputText);
	if (textResult) return textResult;

	// Final fallback: audit step with action: COMPLETE (no findings, no commentBody).
	// The model used the generic template instead of the auditor-specific one.
	// Since structured JSON was emitted with no rejection signal, default APPROVED
	// to prevent pipeline deadlock. Only  for JSON cases, not unstructured output.
	if (hadBareComplete) {
		if (step.markerMap["AUDIT_DECISION: APPROVED"])
			return step.markerMap["AUDIT_DECISION: APPROVED"];
		if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
	}

	return null;
}

/**
 * Extract audit score from agent output.
 * First tries structured AgentOutput.auditScore, then falls back to
 * text marker `AUDIT_SCORE: N/M` pattern (last occurrence wins).
 * Returns null if no score is found.
 */
export interface AuditScore {
	passing: number;
	total: number;
}

export function extractAuditScore(agentOutput: string, toolNames?: Set<string>): AuditScore | null {
	// Try structured JSON parsing first
	const parseResult = parseAgentOutput(agentOutput, toolNames);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		if (output.auditScore) {
			return {
				passing: output.auditScore.passing,
				total: output.auditScore.total,
			};
		}
		// If we have findings but no explicit auditScore, compute it
		if (output.findings && output.findings.length > 0) {
			return computeAuditScoreFromFindings(output.findings);
		}
	}

	// Fallback: text marker detection
	const regex = /AUDIT_SCORE:\s*(\d+)\s*\/\s*(\d+)/g;
	let match: RegExpExecArray | null;
	let lastMatch: RegExpExecArray | null = null;
	while ((match = regex.exec(agentOutput)) !== null) {
		lastMatch = match;
	}
	if (!lastMatch) return null;
	return {
		passing: parseInt(lastMatch[1], 10),
		total: parseInt(lastMatch[2], 10),
	};
}

/**
 * Known audit dimensions for score computation.
 * A dimension is passing if there are no 🔴 Critical or 🟡 Warning findings in it.
 * 🟢 Suggestions do NOT fail a dimension.
 */
const KNOWN_AUDIT_DIMENSIONS = [
	"architecture-compliance",
	"ticket-fulfillment",
	"test-quality",
	"correctness-safety",
	"code-quality",
	"completeness",
	"duplicate-code",
	"research-incorporation",
] as const;

/**
 * Get the active set of audit dimensions, optionally excluding
 * research-incorporation when the researcher agent was skipped.
 *
 * @param researcherSkipped - Whether the researcher was skipped via dedup gate
 * @returns Active dimensions list
 */
export function getActiveAuditDimensions(researcherSkipped: boolean): readonly string[] {
	if (researcherSkipped) {
		return KNOWN_AUDIT_DIMENSIONS.filter((d) => d !== "research-incorporation");
	}
	return KNOWN_AUDIT_DIMENSIONS;
}

/**
 * Compute audit score from structured findings.
 * This replaces LLM-reasoned scoring with deterministic computation.
 *
 * Algorithm:
 * 1. For each finding with severity "critical" or "warning", mark its dimension as failed.
 * 2. "suggestion" findings do NOT fail a dimension.
 * 3. Score = (dimensions without failing findings) / total dimensions.
 *
 * @param findings - Structured audit findings from agent output
 * @param dimensions - Optional explicit dimension list (uses KNOWN_AUDIT_DIMENSIONS by default)
 * @returns Computed audit score
 */
export function computeAuditScoreFromFindings(
	findings: Finding[],
	dimensions?: readonly string[],
): AuditScore {
	const activeDimensions = dimensions ?? KNOWN_AUDIT_DIMENSIONS;
	const failedDimensions = new Set<string>();

	for (const finding of findings) {
		// Only critical and warning findings fail a dimension, and only
		// if the dimension is in the active dimension list — unknown/custom
		// dimensions (e.g., "tests-passed", user-defined ones) do not
		// affect the score.
		if (
			(finding.severity === "critical" || finding.severity === "warning") &&
			(activeDimensions as readonly string[]).includes(finding.dimension)
		) {
			failedDimensions.add(finding.dimension);
		}
	}

	const total = activeDimensions.length;
	const passing = total - failedDimensions.size;

	return { passing: Math.max(0, passing), total };
}

/**
 * Evaluate whether an audit score meets the configured threshold ratio.
 *
 * A score passes if `score.passing >= ceil(score.total * thresholdRatio)`.
 *
 * @param score - The computed audit score
 * @param thresholdRatio - Minimum ratio (0.0–1.0), e.g. 0.75 means at least 75%
 * @returns Object with passes flag and required minimum passing count
 */
export function evaluateAuditScoreGate(
	score: AuditScore,
	thresholdRatio: number,
): { passes: boolean; required: number } {
	const required = Math.ceil(score.total * Math.max(0, Math.min(1, thresholdRatio)));
	return {
		passes: score.passing >= required,
		required,
	};
}

/**
 * Check whether the issue data already contains research findings.
 * This is a pipeline gate — if findings exist, the pipeline can skip
 * dispatching the researcher agent entirely.
 *
 * @param issueData - Filtered issue data (body + comments)
 * @returns true if research findings marker is found anywhere
 */
export function hasResearchFindings(issueData: FilteredIssueData): boolean {
	const marker = /##\s*Research\s*Findings/i;

	// Check issue body
	if (marker.test(issueData.body)) {
		return true;
	}

	// Check all comments
	for (const comment of issueData.comments) {
		if (marker.test(comment.body)) {
			return true;
		}
	}

	return false;
}
