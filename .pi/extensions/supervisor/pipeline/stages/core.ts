// ─── Pipeline Stages — core state machine ────────────────────────
// Stage transition logic: agent dispatch, marker matching, status
// resolution, built-in status handling, audit score tracking.
// The post-agent-success side effects (comments, git ops, auditor
// output) live in sibling modules (agent-comment, git-ops,
// auditor-output, post-agent-success).
// Reconstructed from the pre-split stages.ts (commit f6e2b10^).

import type {
	SupervisorConfig,
	ProjectField,
	PipelineAgentResult,
	AgentRunResult,
} from "../../config/types.ts";
import { combineErrorCount } from "../../session/nested-stats.ts";
import { type AuditScore, WORKFLOW } from "../../config/workflow.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { hasResearchFindings } from "../../config/workflow.ts";
import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";

// ─── Constants ────────────────────────────────────────────────────

export const MAX_PIPELINE_LOOPS = 20;

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

// ─── Check Rejection Limit ────────────────────────────────────────

/** Result of the rejection-limit gate: whether the limit is reached and the real count. */
export interface RejectionLimitResult {
	reached: boolean;
	count: number;
}

/**
 * Compare the precomputed rejection count against the step's maxRejections
 * threshold. The count comes from `countAuditRejections` (labels first, legacy
 * position-0 rejection comments as fallback) so in-place comment updates do
 * not reset the loop counter (issue #2044). No count is reported when no limit
 * is configured.
 */
export function isRejectionLimitReached(
	count: number,
	stepMaxRejections?: number,
): RejectionLimitResult {
	if (!stepMaxRejections || stepMaxRejections <= 0) return { reached: false, count: 0 };
	return { reached: count >= stepMaxRejections, count };
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

function resolveAgentStatus(
	result: AgentRunResult,
	usedRetry: boolean,
): PipelineAgentResult["status"] {
	if (!result.success) return "FAILED";
	return usedRetry ? "SUCCESS (after retry)" : "SUCCESS";
}

export function buildAgentResultEntry(
	result: AgentRunResult,
	usedRetry: boolean,
	model?: string,
): PipelineAgentResult {
	const status = resolveAgentStatus(result, usedRetry);

	return {
		agentName: result.agentName,
		status,
		durationMs: result.durationMs,
		tokenCount: result.tokenCount,
		toolCount: result.toolCount,
		failedToolCount: combineErrorCount(result.failedToolCount, result.nestedErrors),
		model,
		errorOutput: result.errorOutput || undefined,
		// Wall-clock timeout state flows into the pipeline summary table:
		// errorOutput already carries the structured "[Timeout: …]" note
		// (authored by assembleResult / the in-process runner).
		timedOut: result.timedOut,
		configuredTimeoutMs: result.configuredTimeoutMs,
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

// ─── Split-out modules (issue #2001) ─────────────────────────────
// Gate-context and status-resolution live in sibling modules; re-exported
// here so existing importers (and the stages/index.ts barrel) keep working.
export { applyGateFailureContext } from "./gate-context.ts";
export { calculateNextStatus, inferForwardStatus, trackAuditScore } from "./status-resolution.ts";
export type {
	AuditGateContext,
	GateRejected,
	NextStatusResult,
	AuditScoreInfo,
} from "./status-resolution.ts";
