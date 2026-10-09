// ─── Pipeline Handler Package: Agent Loop Steps ──────────────────
// Per-iteration concerns extracted out of runAgentLoop (issue #1886).
// Each helper owns exactly one concern and returns a signal — it never
// mutates the loop's loopStatus / stopReason / prCreationResult primitives
// and never breaks/continues its caller. The dispatch skeleton
// (agent-loop.ts) keeps the MAX_PIPELINE_LOOPS lifecycle and translates
// every signal into a break/continue, preserving the branch order.
//
// No import of ./agent-loop.ts (acyclic within the handler package).
// Helpers import the shared RunContext, never each other's phase modules.

import type {
	AgentRunResult,
	FilteredIssueData,
	ParsedAgent,
	RefusedOutput,
} from "../../config/types.ts";
import { WORKFLOW, type WorkflowStep } from "../../config/workflow.ts";
import { buildAgentTask, summarizeComments } from "../../agent/task.ts";
import { getRefusalInfo } from "../../agent/output.ts";
import { fetchFreshIssueData, loadAgentFile as loadAgentFileHelper } from "../helpers.ts";
import { writeCheckpointFile } from "../state-checkpoint.ts";
import {
	handleBacklogTransition,
	resolveAgentName,
	isRejectionLimitReached,
	applyStatusTransition,
	trackAuditScore,
	shouldSkipResearcher,
	inferForwardStatus,
	buildDuplicateCodeContext,
	computeAuditGateRejection,
	detectPreservedWork,
} from "../stages/index.ts";
import { buildDeadCodeContext } from "../../checks/dead-code.ts";
import { buildVulnContext } from "../../checks/osv-scanner.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { isAuditRejectedComment } from "../../lib/audit-headings.ts";
import type { RunContext } from "./shared.ts";

// ─── Workflow step + agent resolution ────────────────────────────

export type StepResolution =
	| { kind: "step"; step: WorkflowStep }
	| { kind: "terminal"; stopReason: string };

/**
 * Look up the workflow step for the current status. An unknown status is
 * terminal — the branch notifies with the available statuses and logs.
 */
export function resolveStep(runCtx: RunContext, loopStatus: string): StepResolution {
	const { ctx } = runCtx;
	const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
	if (!step) {
		ctx.ui.notify(
			`No workflow step for status '${loopStatus}'. Available: ${WORKFLOW.map((s) => s.status).join(", ")}`,
			"error",
		);
		getDebugLogger().error("handler", "No workflow step", { loopStatus });
		return { kind: "terminal", stopReason: `No workflow step for status '${loopStatus}'` };
	}
	return { kind: "step", step };
}

export type AgentResolution =
	| { kind: "agent"; agentName: string }
	| { kind: "terminal"; stopReason: string };

/**
 * Resolve the agent for the current status. Missing mapping is terminal.
 */
export function resolveLoopAgent(runCtx: RunContext, loopStatus: string): AgentResolution {
	const { ctx, config } = runCtx;
	const agentName = resolveAgentName(loopStatus, config);
	if (!agentName) {
		ctx.ui.notify(`No agent for status '${loopStatus}'`, "error");
		getDebugLogger().error("handler", "No agent for status", { loopStatus });
		return { kind: "terminal", stopReason: `No agent for status '${loopStatus}'` };
	}
	return { kind: "agent", agentName };
}

// ─── Built-in steps ──────────────────────────────────────────────

/**
 * Built-in Backlog → Research transition. Returns the new loop status when
 * the step is the backlog built-in, otherwise null (not this step).
 */
export async function runBacklogStep(
	runCtx: RunContext,
	step: WorkflowStep,
): Promise<string | null> {
	if (step.builtIn !== "backlog") return null;
	const { ctx, issueNum, port, fields, statusField, loopItem, projectId } = runCtx;
	const loopStatus = await handleBacklogTransition(
		port,
		fields,
		statusField.id,
		loopItem.id,
		projectId,
	);
	ctx.ui.notify(`Issue #${issueNum} moved: Backlog → Research`, "info");
	getDebugLogger().info("handler", "Backlog → Research");
	return loopStatus;
}

/**
 * Built-in Done step. Returns true when the pipeline reached the Done
 * built-in (the caller breaks), false otherwise.
 */
export function runDoneStep(runCtx: RunContext, step: WorkflowStep): boolean {
	if (step.builtIn !== "done") return false;
	runCtx.ctx.ui.notify(`Issue #${runCtx.issueNum} is Done. Pipeline complete.`, "info");
	getDebugLogger().info("handler", "Pipeline complete — Done status");
	return true;
}

// ─── Fresh issue data + rejection limit ──────────────────────────

export type IssueResolution =
	| { kind: "loaded"; data: FilteredIssueData }
	| { kind: "terminal"; stopReason: string };

/**
 * Fetch fresh issue data and apply the rejection limit. Reaching the limit
 * is terminal (human intervention required).
 */
export async function loadLoopIssue(
	runCtx: RunContext,
	step: WorkflowStep,
): Promise<IssueResolution> {
	const { ctx, config, issueNum, exec, collector, issueData } = runCtx;
	const loopFilteredData = await fetchFreshIssueData(
		exec,
		config,
		issueNum,
		issueData,
		collector,
	);

	// Rejection limit check (issue #1668: reports the real count, not the
	// threshold; only position-0 `## Audit Rejected` comments count).
	const rejectionLimit = isRejectionLimitReached(loopFilteredData.comments, step.maxRejections);
	if (rejectionLimit.reached) {
		ctx.ui.notify(
			`Issue #${issueNum} rejected ${rejectionLimit.count} times. Human intervention required.`,
			"error",
		);
		getDebugLogger().warn("handler", "Rejection limit reached", {
			maxRejections: step.maxRejections,
			rejectionCount: rejectionLimit.count,
		});
		return {
			kind: "terminal",
			stopReason: `Rejection limit reached (${rejectionLimit.count})`,
		};
	}
	return { kind: "loaded", data: loopFilteredData };
}

// ─── Researcher deduplication gate ───────────────────────────────

export type DedupOutcome = { kind: "advanced"; loopStatus: string } | { kind: "proceed" };

/**
 * When findings already exist, skip the researcher and advance to the next
 * forward status. Signals "advanced" with the new loop status; "proceed"
 * means dispatch normally (either not a researcher step, or no forward
 * status to infer).
 */
export async function runResearcherDedupGate(
	runCtx: RunContext,
	step: WorkflowStep,
	loopStatus: string,
	agentName: string,
	loopFilteredData: FilteredIssueData,
): Promise<DedupOutcome> {
	if (agentName !== "researcher" || !shouldSkipResearcher(loopStatus, loopFilteredData)) {
		return { kind: "proceed" };
	}
	const { ctx, issueNum, port, loopItem, projectId, fields, statusField, stageState } = runCtx;
	ctx.ui.notify(`Issue #${issueNum} already has research findings — skipping researcher`, "info");
	getDebugLogger().info("handler", "Skipping researcher — findings exist");
	stageState.researcherSkipped = true;
	// Find the next forward status for the researcher step
	const nextStatus = inferForwardStatus(step);
	if (!nextStatus) return { kind: "proceed" };
	const nextLoopStatus = await applyStatusTransition(
		port,
		loopItem.id,
		projectId,
		fields,
		statusField.id,
		nextStatus,
	);
	ctx.ui.notify(`Issue #${issueNum} moved: Research → ${nextStatus} (deduplication gate)`, "info");
	getDebugLogger().info("handler", `Research → ${nextStatus} (dedup gate)`);
	return { kind: "advanced", loopStatus: nextLoopStatus };
}

// ─── Pre-auditor checkpoint + agent file ─────────────────────────

/**
 * Write the pre-auditor checkpoint before the heavy auditor dispatch.
 * Only fires for the auditor with a worktree present; a write failure is a
 * warning (never a stop).
 */
export function writePreAuditorCheckpoint(runCtx: RunContext, agentName: string): void {
	const { ctx, issueNum, worktreePath, worktreeBranch } = runCtx;
	if (agentName !== "auditor" || !worktreePath || !worktreeBranch) return;
	const checkpointResult = writeCheckpointFile(ctx.cwd, {
		issueNum,
		checkpoint: "pre-auditor",
		worktreePath,
		worktreeBranch,
		startedAt: new Date().toISOString(),
	});
	if (!checkpointResult.ok) {
		ctx.ui.notify(
			`Warning: Failed to write pre-auditor checkpoint: ${checkpointResult.error}`,
			"warning",
		);
		getDebugLogger().warn("handler", "Failed to write pre-auditor checkpoint", {
			error: checkpointResult.error,
		});
	}
}

export type AgentFileResolution =
	| { kind: "loaded"; agent: ParsedAgent }
	| { kind: "missing"; stopReason: string };

/**
 * Load the agent file for the current step. A missing/unparseable file is
 * terminal (loadAgentFile already surfaced the error via notify/collector).
 */
export async function loadLoopAgentFile(
	runCtx: RunContext,
	agentName: string,
): Promise<AgentFileResolution> {
	const { exec, notify, ctx, collector } = runCtx;
	const agent = await loadAgentFileHelper(exec, notify, ctx.cwd, agentName, collector);
	if (!agent) {
		getDebugLogger().error("handler", "Agent file not found", { agentName });
		return { kind: "missing", stopReason: `Agent file not found: ${agentName}` };
	}
	return { kind: "loaded", agent };
}

// ─── Task assembly ───────────────────────────────────────────────

/**
 * Build the per-agent task string: the agent-specific context blocks
 * (duplicate code / research findings / audit feedback / dead code / vuln)
 * plus the shared buildAgentTask call. The pre-Implementation rebase
 * context is resolved by the caller and threaded in unchanged.
 */
export async function assembleAgentTask(
	runCtx: RunContext,
	agentName: string,
	loopFilteredData: FilteredIssueData,
	rebaseConflictContext: string | undefined,
): Promise<string> {
	const {
		ctx,
		pi,
		config,
		issueNum,
		issueTitle,
		worktreePath,
		worktreeBranch,
		systemPromptOptions,
		stageState,
	} = runCtx;

	// Resume-instead-of-restart (issue #1987): a prior timed-out developer run
	// pushed a marked wip(#N) commit; feed it to task assembly so the next run
	// continues instead of restarting.
	const wipResumeContext =
		agentName === "developer" && worktreePath
			? await detectPreservedWork(pi, worktreePath, issueNum)
			: undefined;

	const dupContext: string | undefined =
		agentName === "auditor"
			? (buildDuplicateCodeContext(stageState.duplicateCodeResult) ?? undefined)
			: undefined;
	// Extract research findings from issue comments for architect
	const researchFindings: string | undefined =
		agentName === "architect"
			? loopFilteredData.comments
					.map((c) => c.body)
					.find((body) => /##\s*Research\s*Findings/i.test(body))
			: undefined;
	// Extract latest audit rejection comment for developer feedback loop
	// When audit rejects and pipeline loops back to Implementation, the developer
	// needs to see EXACTLY what the auditor found wrong — not just a generic
	// list of trusted comments where audit feedback is buried.
	const auditFeedback: string | undefined =
		agentName === "developer"
			? (() => {
					// Find the latest comment BEGINNING with the "## Audit Rejected"
					// heading (position-0 only — quoted occurrences must not be fed
					// to the developer as rejection feedback, issue #1668).
					for (let i = loopFilteredData.comments.length - 1; i >= 0; i--) {
						const body = loopFilteredData.comments[i]?.body || "";
						if (isAuditRejectedComment(body)) {
							return body;
						}
					}
					return undefined;
				})()
			: undefined;
	// Build dead code context for auditor
	const deadContext: string | undefined =
		agentName === "auditor"
			? (buildDeadCodeContext(stageState.deadCodeResult) ?? undefined)
			: undefined;
	// Build vuln context for auditor
	const vulnContext: string | undefined =
		agentName === "auditor" && stageState.vulnResult
			? buildVulnContext(stageState.vulnResult)
			: undefined;

	const task = buildAgentTask(
		agentName,
		issueNum,
		config.repo,
		issueTitle,
		loopFilteredData,
		config.defaultBranch!,
		config.remote!,
		config.worktreeBase!,
		config.branchPrefix!,
		ctx.cwd, // mainRepoPrefix
		worktreePath,
		worktreeBranch,
		summarizeComments(loopFilteredData.comments),
		dupContext,
		researchFindings,
		auditFeedback,
		deadContext,
		vulnContext,

		stageState.gateFailureContext,
		systemPromptOptions,
		rebaseConflictContext,
		wipResumeContext,
	);
	return task;
}

// ─── Post-dispatch bookkeeping ───────────────────────────────────

export interface DispatchRecord {
	gateRejected: ReturnType<typeof computeAuditGateRejection>;
	refusedOutput: RefusedOutput | null;
}

/**
 * Post-dispatch bookkeeping: the after-push trace, audit-score tracking
 * (with notify), the pre-computed audit gate decision and the refusal
 * parse (issue #1618). Returns the two values the skeleton threads forward.
 */
export function recordPostDispatch(
	runCtx: RunContext,
	agentName: string,
	result: AgentRunResult,
	iteration: number,
): DispatchRecord {
	const { ctx, config, agentResults, stageState } = runCtx;

	// Debug tracing: agentResults after push (R3 requirement)
	getDebugLogger().info("handler", "agentResults after push", {
		length: agentResults.length,
		lastAgent: agentResults[agentResults.length - 1]?.agentName,
		iteration,
	});

	// Track audit score
	const auditInfo = trackAuditScore(result.textOnly, stageState, new Set(result.toolCalls ?? []));
	if (auditInfo) {
		ctx.ui.notify(
			`Audit #${auditInfo.cycleCount} score: ${auditInfo.score.passing}/${auditInfo.score.total}${auditInfo.trend ? ` (${auditInfo.trend})` : ""}`,
			"info",
		);
		getDebugLogger().info("handler", "Audit score tracked", {
			cycleCount: auditInfo.cycleCount,
			score: auditInfo.score,
			trend: auditInfo.trend,
		});
	}

	// Pre-compute audit score gate decision for auditor
	// This runs BEFORE handlePostAgentSuccess so the gate rejection
	// comment can replace the normal approval comment.
	const gateRejected = computeAuditGateRejection(agentName, result, config, stageState, ctx);

	// Refusal short-circuit (issue #1618): when the agent declined the task
	// via the documented `refusal` field it owns no post-success side effects.
	// Parse matches calculateNextStatus' refusal detection (textOutput) and is
	// NOT gated on result.success: a budget-exceeded run reports success=false
	// yet may still carry a structured refusal, which must override the
	// budget-degradation path below (audit fix). Unparseable failed output
	// degrades to FailedParse → isRefused false → null.
	const refusedOutput: RefusedOutput | null = getRefusalInfo(
		result.textOutput,
		new Set(result.toolCalls ?? []),
	);

	return { gateRejected, refusedOutput };
}
