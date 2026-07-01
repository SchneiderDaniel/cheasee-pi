// ─── Pipeline Stages ─────────────────────────────────────────────
// Stage transition logic: agent dispatch, marker matching, status
// resolution, built-in status handling, audit score tracking,
// and post-agent-success side effects.
// Extracted from handler.ts to keep that file < 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	PipelineAgentResult,
	AgentRunResult,
	FilteredIssueData,
} from "../config/types.ts";
import type { ErrorCollector } from "./error-collector.ts";
import type { NotifyFn } from "./helpers.ts";
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
} from "../config/workflow.ts";
import { setItemStatus } from "../github/project.ts";
import {
	postIssueComment,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
	commitAndPush,
} from "../github/index.ts";
import { hasResearchFindings } from "../config/workflow.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent/output.ts";
import type { AgentOutput } from "../config/types.ts";
import type { DuplicateCodeResult } from "../checks/duplicate-code.ts";
import { buildDeadCodeContext as buildDeadCodeContextInner } from "../checks/dead-code.ts";
import type { DeadCodeResult } from "../checks/dead-code.ts";
import type { OsvScanResult } from "../checks/osv-scanner.ts";

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
	pi: ExtensionAPI,
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
		await setItemStatus(pi.exec.bind(pi), itemId, projectId, statusFieldId, optId);
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

import { buildVulnContext as buildVulnContextInner } from "../checks/osv-scanner.ts";

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
	const structuredStatus = resolveNextStatusFromAgentOutput(step, agentOutput);
	if (structuredStatus) {
		// Audit score gate: when auditor APPROVED but score below threshold,
		// override to Implementation and attach gate rejection details
		if (agentName === "auditor" && structuredStatus === "Done" && auditContext) {
			const parseResult = parseAgentOutput(agentOutput);
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

/**
 * Check whether a branch has any commits ahead of a base branch.
 * Uses `git rev-list --count` to compare.
 *
 * Fail-safe: returns true (allows pipeline to continue) if the git command
 * fails or throws, since this is a pre-condition check that should not
 * block the pipeline on infrastructure issues.
 *
 * @param execFn - Function to execute shell commands
 * @param worktreePath - Path to the worktree
 * @param headBranch - Branch name to check (e.g. "feature/my-feature")
 * @param baseBranch - Base branch to compare against (e.g. "main")
 * @returns true if branch has commits ahead of base, false if empty
 */
export async function hasBranchCommits(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	worktreePath: string,
	headBranch: string,
	baseBranch: string,
): Promise<boolean> {
	try {
		const result = await execFn("git", ["rev-list", "--count", `${baseBranch}..${headBranch}`], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (result.code !== 0) {
			// Command failed — fail-safe: allow pipeline to continue
			return true;
		}
		const count = parseInt(result.stdout?.trim() || "0", 10);
		return count > 0;
	} catch {
		// Exception — fail-safe: allow pipeline to continue
		return true;
	}
}

// ─── Audit Score Tracking ─────────────────────────────────────────

export interface AuditScoreInfo {
	cycleCount: number;
	score: AuditScore;
	trend?: "improving" | "declining" | "stable";
}

/**
 * Track audit scores across pipeline iterations.
 * Returns the audit score info if a score marker is found, null otherwise.
 */
export function trackAuditScore(agentOutput: string, state: StageState): AuditScoreInfo | null {
	const currentAuditScore = extractAuditScore(agentOutput);
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
	pi: ExtensionAPI,
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
	await setItemStatus(pi.exec.bind(pi), itemId, projectId, statusFieldId, optId);
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

// ─── Post-Agent Success Processing ────────────────────────────────

/**
 * Handle post-agent-success side effects: issue comments, commit/push.
 */
export async function handlePostAgentSuccess(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	loopFilteredData: FilteredIssueData,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	issueTitle: string,
	collector?: ErrorCollector,
	gateRejected?: GateRejected,
	notify?: NotifyFn,
): Promise<boolean> {
	// Agent comments: architect, test-designer, researcher
	if (agentName === "architect" || agentName === "test-designer" || agentName === "researcher") {
		// Try multiple sources. textOnly is clean LLM text (no tool/thinking noise).
		// textOutput / output fallbacks handle cases where JSON lived in streaming
		// deltas not captured by textOutputLines (rare).
		let commentBody: string | null = null;
		let extractionSource = "";

		// Primary: textOnly — clean text output from the LLM (no tool/thinking noise).
		// This is the expected path for all models. The agent's JSON structured output
		// is at the end of the text response. textOnly avoids capturing tool call
		// results, thinking blocks, system prompt echoes, and context info that would
		// bleed into the section heading extraction fallback.
		if (result.textOnly) {
			commentBody = extractAgentCommentBody(result.textOnly);
			if (commentBody) {
				extractionSource = "result.textOnly";
			}
		}

		// Fallback 1: textOutput (full instrumented log) — contains JSON from deltas
		// when textOnly is empty (edge case: non-streaming or subprocess-only agents).
		if (!commentBody && result.textOutput) {
			commentBody = extractAgentCommentBody(result.textOutput);
			if (commentBody) {
				extractionSource = "result.textOutput";
				collector?.push(
					"stages",
					"warn",
					`${agentName} commentBody extracted from result.textOutput (fallback after textOnly)`,
				);
			}
		}

		// Fallback 2: thinkingOutput — models with thinking:high may emit
		// JSON in thinking blocks which land in thinkingOutputLines.
		//
		// NOTE: result.output (raw subprocess stdout) is intentionally omitted
		// from this fallback chain. Raw stdout contains pi internal protocol
		// (NDJSON events, agent_end with full conversation dump, model metadata)
		// and using it as a comment source leaks system prompts, tool results,
		// and token usage to GitHub issues. textOnly → textOutput → thinkingOutput
		// covers all agent output formats without touching raw subprocess output.
		// The pipeline ran ~1000 issues without result.output before the
		// session-dump event existed.
		if (!commentBody && result.thinkingOutput) {
			commentBody = extractAgentCommentBody(result.thinkingOutput);
			if (commentBody) {
				extractionSource = "result.thinkingOutput";
				collector?.push(
					"stages",
					"warn",
					`${agentName} commentBody extracted from result.thinkingOutput (fallback)`,
				);
			}
		}

		// Tertiary fallback: bare text detection for architect, test-designer, researcher.
		// When agent omits JSON and section headings, detect role-relevant content
		// and wrap in default heading so review is not silently lost.
		if (!commentBody) {
			const rawOutput = result.textOutput || result.output || "";
			let wrapped: string | null = null;

			if (agentName === "architect") {
				if (/^Architecture[^a-zA-Z]/.test(rawOutput) || /\bArchitecture\b/i.test(rawOutput)) {
					wrapped = `## Architecture\n\n${rawOutput.trim().slice(0, 2000)}`;
				}
			} else if (agentName === "test-designer") {
				if (/^Test\s*Plan[^a-zA-Z]/.test(rawOutput) || /\bTest\s*Plan\b/i.test(rawOutput)) {
					wrapped = `## Test Plan\n\n${rawOutput.trim().slice(0, 2000)}`;
				}
			} else if (agentName === "researcher") {
				if (/^Research[^a-zA-Z]/.test(rawOutput) || /\bResearch\b/i.test(rawOutput)) {
					wrapped = `## Research Findings\n\n${rawOutput.trim().slice(0, 2000)}`;
				}
			}

			if (wrapped) {
				commentBody = wrapped;
				extractionSource = "bare-text-fallback";
				collector?.push(
					"stages",
					"warn",
					`${agentName} commentBody extracted from bare text fallback (no JSON or heading found)`,
				);
			}
		}

		// Validate researcher output: if commentBody is just empty headers with no
		// actual findings (e.g. "### Best Practices\n- —"), replace with fallback.
		if (commentBody && agentName === "researcher") {
			const validated = validateResearcherFindings(commentBody);
			if (validated !== commentBody) {
				collector?.push(
					"stages",
					"warn",
					`researcher commentBody has no substantive findings (source: ${extractionSource}). Replacing with graceful degradation message.`,
				);
				commentBody = validated;
			}
		}

		// Validate test-designer output must contain "## Test Plan" heading.
		// Prevents agent from posting architecture review / risk flag instead of a test plan.
		// This catches cases where the LLM confuses its role or the heading extraction picks
		// a wrong section heading due to prefix-matching in earlier extraction logic.
		// Instead of dropping the comment entirely (losing the test plan), inject the
		// heading so the issue still gets visible output. Warn for debugging.
		if (commentBody && agentName === "test-designer" && !commentBody.includes("## Test Plan")) {
			collector?.push(
				"stages",
				"warn",
				`test-designer commentBody missing "## Test Plan" heading. ` +
					`Injecting heading. commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}. ` +
					`Source: ${extractionSource}`,
			);
			// ponytail: inject heading instead of dropping comment. The model may have
			// output a valid test plan without the heading; heading is pipeline formatting.
			commentBody = "## Test Plan\n\n" + commentBody;
		}

		// Validate architect output must contain "## Architecture" heading.
		// Prevents agent from posting empty or wrong-headed content.
		// Instead of dropping the comment entirely, inject the heading.
		if (commentBody && agentName === "architect" && !commentBody.includes("## Architecture")) {
			collector?.push(
				"stages",
				"warn",
				`architect commentBody missing "## Architecture" heading. ` +
					`Injecting heading. commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}. ` +
					`Source: ${extractionSource}`,
			);
			// ponytail: inject heading instead of dropping comment.
			commentBody = "## Architecture\n\n" + commentBody;
		}

		// Defense-in-depth: strip trailing broken ```json code fences from any agent comment.
		// If the heading extraction (Fallback 2 in extractAgentCommentBody) fails to strip
		// the agent's structured JSON block — either truncated mid-JSON or complete — the
		// raw code fence leaks into the posted comment. This catch-all strips any trailing
		// ```json fence still present after extraction.
		if (commentBody) {
			const lastBacktickFence = commentBody.lastIndexOf("\n```json");
			if (lastBacktickFence !== -1) {
				// Check if the fence is at the end of the content (no substantive text after it)
				const afterFence = commentBody.slice(lastBacktickFence + 1).trim();
				// Strip if the fence contains only JSON (not legitimate code examples in comment)
				const trimmed = commentBody.slice(0, lastBacktickFence).trim();
				if (trimmed.length >= 50) {
					commentBody = trimmed;
				} else {
					// After stripping fence, content too short — comment is just broken JSON wrapper
					collector?.push(
						"stages",
						"warn",
						`${agentName} commentBody is only a broken \`\`\`json fence — skipping post. ` +
							`commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}`,
					);
					commentBody = null;
				}
			}
		}

		// Validate research findings output must contain "## Research Findings" heading.
		if (
			commentBody &&
			agentName === "researcher" &&
			!commentBody.includes("## Research Findings")
		) {
			collector?.push(
				"stages",
				"warn",
				`researcher commentBody missing "## Research Findings" heading. ` +
					`commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}. ` +
					`Skipping post. Source: ${extractionSource}`,
			);
			commentBody = null;
		}

		// When researcher budget was exceeded, compose a single combined comment
		// with "stopped early" header + partial findings, so the budget-exceeded
		// handler in handler.ts can skip its own separate comment (no duplication).
		// The existing heading is replaced to avoid redundant headings.
		if (commentBody && agentName === "researcher" && result.budgetExceeded) {
			const budgetHeader = `## Research Findings — Research stopped early: agent exceeded token budget (${result.tokenCount} tokens used). Pipeline continues without full research findings.`;
			const firstNewline = commentBody.indexOf("\n");
			if (firstNewline !== -1) {
				commentBody = budgetHeader + commentBody.slice(firstNewline);
			} else {
				commentBody = budgetHeader;
			}
		}

		if (commentBody) {
			try {
				await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, commentBody);
				ctx.ui.notify(`Posted ${agentName} comment on issue #${issueNum}`, "info");
			} catch (commentErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post ${agentName} comment: ${
						commentErr instanceof Error ? commentErr.message : String(commentErr)
					}`,
				);
			}
		} else {
			// Graceful degradation: researcher with no commentBody still
			// posts a "no findings" comment so issue has visible researcher output.
			// Prevents silent skip when LLM treats commentBody as optional and omits it.
			if (agentName === "researcher") {
				const fallbackComment = "## Research Findings — No relevant results found for this topic.";

				// Check if researcher output had valid structured JSON (even without commentBody).
				// If so, null commentBody was intentional — researcher decided "nothing to research."
				// Only warn if NO valid JSON output was produced at all (crash/parse failure).
				const researcherOutput = result.textOutput || result.output || "";
				const parseResult = parseAgentOutput(researcherOutput);
				const hadValidStructuredOutput = isAgentOutputSuccess(parseResult);

				if (!hadValidStructuredOutput) {
					collector?.push(
						"stages",
						"warn",
						`${agentName} completed but no commentBody in JSON output. ` +
							`Posting graceful degradation comment. ` +
							`textOutput: ${JSON.stringify((result.textOutput || "").slice(0, 200))}, ` +
							`output: ${JSON.stringify((result.output || "").slice(0, 200))}`,
					);
				}
				try {
					await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, fallbackComment);
					ctx.ui.notify(
						`Posted ${agentName} comment (graceful degradation) on issue #${issueNum}`,
						"info",
					);
				} catch (commentErr: unknown) {
					collector?.push(
						"stages",
						"warn",
						`Failed to post ${agentName} graceful degradation comment: ${
							commentErr instanceof Error ? commentErr.message : String(commentErr)
						}`,
					);
				}
			} else {
				collector?.push(
					"stages",
					"warn",
					`${agentName} completed but no commentBody found. ` +
						`textOutput: ${JSON.stringify((result.textOutput || "").slice(0, 200))}, ` +
						`output: ${JSON.stringify((result.output || "").slice(0, 200))}`,
				);
			}
		}
	}

	// Commit and push for developer
	if (agentName === "developer" && worktreePath && worktreeBranch) {
		const commitMsg = `feat(#${issueNum}): ${issueTitle}`;
		// Use provided notify or create a null-safe fallback
		const pushNotify: NotifyFn = notify || {
			info: (msg) => ctx.ui.notify(msg, "info"),
			error: (msg) => ctx.ui.notify(msg, "error"),
		};
		const commitResult = await commitAndPush(
			pi.exec.bind(pi),
			worktreePath,
			config.remote!,
			worktreeBranch,
			commitMsg,
			pushNotify,
		);
		if (!commitResult.ok) {
			ctx.ui.notify(`commitAndPush failed: ${commitResult.error}`, "warning");
			collector?.push("stages", "error", `commitAndPush failed: ${commitResult.error}`);
			return false;
		}
		if (commitResult.value) {
			ctx.ui.notify("Changes committed and pushed to branch", "info");
		} else {
			ctx.ui.notify("No changes to commit — pipeline continues", "info");
		}
	}

	// Audit output processing
	if (agentName === "auditor") {
		// Use textOutput over textOnly — textOnly can be very short (3 chars) for
		// models like minimax-m3 that emit structured JSON with minimal text lines,
		// causing the || chain to shadow the full output. Mirror the other agents'
		// fallback pattern: textOutput always contains the full agent log + JSON.
		const auditorOutput = result.textOutput || result.output || "";
		await handleAuditorOutput(
			pi,
			ctx,
			auditorOutput,
			result,
			issueNum,
			config,
			collector,
			gateRejected,
		);
	}

	// Default: pipeline should continue
	return true;
}

/**
 * Handle auditor-specific output: structured comments for approval/rejection.
 * Uses parseAgentOutput for deterministic comment building.
 * When gateRejected is set, posts a gate rejection comment explaining the
 * score threshold failure, overriding the normal approval comment.
 */
async function handleAuditorOutput(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	result: AgentRunResult,
	issueNum: number,
	config: SupervisorConfig,
	collector?: ErrorCollector,
	gateRejected?: GateRejected,
): Promise<void> {
	// Debug: log what we received
	collector?.push(
		"stages",
		"warn",
		`auditor handleAuditorOutput: textOnly=${String(result.textOnly).length} textOutput=${String(result.textOutput).length} output=${String(result.output).length} agentOutput=${String(agentOutput).length} gateRejected=${String(!!gateRejected)}`,
	);

	// If gate rejected, post gate-specific rejection comment and skip normal processing
	if (gateRejected) {
		const gateBody = buildGateRejectionComment(gateRejected);
		if (gateBody) {
			try {
				await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, gateBody);
				ctx.ui.notify(
					`Audit score gate rejected: ${gateRejected.score.passing}/${gateRejected.total} < ${gateRejected.required}/${gateRejected.total}`,
					"warning",
				);
			} catch (grErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post gate rejection comment: ${
						grErr instanceof Error ? grErr.message : String(grErr)
					}`,
				);
			}
		}
		return;
	}

	// Try structured AgentOutput parsing first
	const parseResult = parseAgentOutput(agentOutput);
	let actionFromOutput: "APPROVED" | "REJECTED" | undefined;
	let commentBodyFromOutput: string | undefined;

	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		collector?.push(
			"stages",
			"warn",
			`auditor parseAgentOutput SUCCESS: action=${output.action} hasCommentBody=${String(!!output.commentBody)} findings=${String(output.findings?.length)}`,
		);
		if (output.action === "APPROVED" || output.action === "REJECTED") {
			actionFromOutput = output.action;
			commentBodyFromOutput = output.commentBody;
		} else if (output.action === "COMPLETE") {
			// Map COMPLETE to APPROVED/REJECTED based on findings.
			// Minimax-m3 often uses the generic template instead of the
			// auditor-specific APPROVED/REJECTED, causing silent-drops.
			// Mirrors resolveNextStatusFromAgentOutput logic in workflow.ts.
			if (output.findings && output.findings.length > 0) {
				const hasBlockers = output.findings.some(
					(f) => f.severity === "critical" || f.severity === "warning",
				);
				actionFromOutput = hasBlockers ? "REJECTED" : "APPROVED";
			} else {
				actionFromOutput = "APPROVED";
			}
			commentBodyFromOutput = output.commentBody;
		}
	}

	// Fallback to old text-marker-based extraction
	if (!actionFromOutput) {
		const auditOutput = extractStructuredAuditOutput(agentOutput);

		// Tertiary fallback: bare approval/rejection text (agent skipped structured format)
		// Detect lines like "Approved: ..." or "Rejected: ..." or just "Approved"/"Rejected"
		// and wrap into a default comment so the review is not silently lost.
		if (!auditOutput) {
			const trimmed = agentOutput.trim();
			const approvedMatch = /^Approved[^a-zA-Z]/.test(trimmed) || /\bApproved\b/i.test(trimmed);
			const rejectedMatch = /^Rejected[^a-zA-Z]/.test(trimmed) || /\bRejected\b/i.test(trimmed);

			if (approvedMatch && !rejectedMatch) {
				try {
					const body = `## Audit Approved\n\n${trimmed.slice(0, 2000)}`;
					await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, body);
					ctx.ui.notify("Audit approval comment posted (bare text fallback)", "info");
				} catch (acErr: unknown) {
					collector?.push(
						"stages",
						"warn",
						`Failed to post audit comment (bare text fallback): ${acErr instanceof Error ? acErr.message : String(acErr)}`,
					);
				}
			} else if (rejectedMatch) {
				try {
					const body = `## Audit Rejected\n\n${trimmed.slice(0, 2000)}`;
					await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, body);
					ctx.ui.notify("Audit rejection comment posted (bare text fallback)", "info");
				} catch (rcErr: unknown) {
					collector?.push(
						"stages",
						"warn",
						`Failed to post rejection comment (bare text fallback): ${rcErr instanceof Error ? rcErr.message : String(rcErr)}`,
					);
				}
			}
			return;
		}

		if (auditOutput.decision === "APPROVED") {
			const bodyToPost = auditOutput.commentBody || buildApprovalCommentFromOutput(agentOutput);
			if (bodyToPost) {
				try {
					await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, bodyToPost);
					ctx.ui.notify("Audit comment posted (text marker fallback)", "info");
				} catch (acErr: unknown) {
					collector?.push(
						"stages",
						"warn",
						`Failed to post audit comment: ${
							acErr instanceof Error ? acErr.message : String(acErr)
						}`,
					);
				}
			}
		} else if (auditOutput.decision === "REJECTED") {
			const bodyToPost = auditOutput.commentBody || buildRejectionCommentFromOutput(agentOutput);
			if (bodyToPost) {
				try {
					await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, bodyToPost);
					ctx.ui.notify("Audit rejection comment posted (text marker fallback)", "info");
				} catch (rcErr: unknown) {
					collector?.push(
						"stages",
						"warn",
						`Failed to post rejection comment: ${
							rcErr instanceof Error ? rcErr.message : String(rcErr)
						}`,
					);
				}
			}
		}
		return;
	}

	// Structured path: build comment from AgentOutput
	if (actionFromOutput === "APPROVED") {
		collector?.push(
			"stages",
			"warn",
			`auditor APPROVED path: commentBodyFromOutput.length=${String(commentBodyFromOutput?.length)}`,
		);
		const bodyToPost = commentBodyFromOutput || buildApprovalCommentFromOutput(agentOutput);
		if (bodyToPost) {
			try {
				await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit approval comment posted (from structured output)", "info");
			} catch (acErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post audit comment: ${acErr instanceof Error ? acErr.message : String(acErr)}`,
				);
			}
		}
	} else if (actionFromOutput === "REJECTED") {
		const bodyToPost = commentBodyFromOutput || buildRejectionCommentFromOutput(agentOutput);
		if (bodyToPost) {
			try {
				await postIssueComment(pi.exec.bind(pi), issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit rejection comment posted (from structured output)", "info");
			} catch (rcErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post rejection comment: ${
						rcErr instanceof Error ? rcErr.message : String(rcErr)
					}`,
				);
			}
		} else {
			collector?.push(
				"stages",
				"warn",
				`Auditor rejected issue #${issueNum} but no comment body or structured output available.`,
			);
		}
	}
}

/**
 * Shared audit comment builder — parameterised with title and footer
 * to avoid duplicating the entire audit score + findings rendering.
 */
function buildAuditComment(agentOutput: string, title: string, footer: string): string | null {
	const parseResult = parseAgentOutput(agentOutput);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		const lines: string[] = [title, ""];

		if (output.auditScore) {
			const passing = output.auditScore.passing;
			const total = output.auditScore.total;
			lines.push(
				`**Score:** ${passing}/${total} — ${passing === total ? "All dimensions passing" : `${passing} of ${total} dimensions passing`}`,
			);
			lines.push("");
		}

		if (output.findings && output.findings.length > 0) {
			lines.push("### Findings");
			lines.push("");
			for (const finding of output.findings) {
				lines.push(`- **${finding.severity} — ${finding.dimension}**`);
				if (finding.symptom) lines.push(`  - Symptom: ${finding.symptom}`);
				if (finding.consequence) lines.push(`  - Consequence: ${finding.consequence}`);
				if (finding.remedy) lines.push(`  - Remedy: ${finding.remedy}`);
				if (finding.location) lines.push(`  - Location: ${finding.location}`);
			}
			lines.push("");
		}

		lines.push(footer);
		return lines.join("\n");
	}

	return null;
}

/**
 * Build an approval comment from AgentOutput fields when no explicit commentBody provided.
 */
export function buildApprovalCommentFromOutput(agentOutput: string): string | null {
	return buildAuditComment(agentOutput, "## Audit Approved", "Fix and resubmit if issues remain.");
}

/**
 * Build a rejection comment from AgentOutput fields when no explicit commentBody provided.
 */
export function buildRejectionCommentFromOutput(agentOutput: string): string | null {
	return buildAuditComment(agentOutput, "## Audit Rejected", "Fix the issues above and resubmit.");
}

/**
 * Build a gate rejection comment explaining that the audit score did not
 * meet the configured threshold.
 */
function buildGateRejectionComment(gateRejected: GateRejected): string | null {
	const lines: string[] = [
		"## Audit Score Gate Rejected",
		"",
		`**Score:** ${gateRejected.score.passing}/${gateRejected.total} — requires at least ${gateRejected.required}/${gateRejected.total} (threshold: ${gateRejected.required}/${gateRejected.total})`,
		"",
		"The audit score gate determines whether the audit passes based on the structured findings. " +
			"The auditor's findings did not cover enough quality dimensions to meet the threshold.",
		"",
		"### How to fix",
		"",
		"- Review the audit findings below for specific issues",
		"- Address all 🔴 Critical and 🟡 Warning findings",
		"- Ensure findings span multiple quality dimensions (architecture-compliance, ticket-fulfillment, test-quality, correctness-safety, code-quality, completeness, duplicate-code, research-incorporation)",
		"- The score is computed from CRITICAL and WARNING findings only — suggestions do not affect the score",
		"",
		"Returning to Implementation for fixes.",
	];
	return lines.join("\n");
}
