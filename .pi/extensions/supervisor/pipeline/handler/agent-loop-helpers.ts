// ─── Pipeline Handler Package: Agent Loop helpers ────────────────
// Extracted from agent-loop.ts (issue #2005 Long File refactor). Holds the
// per-iteration policy helpers the dispatch skeleton delegates to:
// reportTimedOutAgent, refreshWorktreeBeforeImplementation,
// dispatchAgentWithRetry, handleBudgetExceeded, runPreTransitionHooks.
// Acyclic: imports ./shared.ts and stages only — never ./agent-loop.ts,
// ./preflight.ts, ./post-pipeline.ts or ./index.ts. Each helper ≤100 lines
// (S138); call sites stay in agent-loop.ts (explicit named re-exports).

import type {
	AgentRunResult,
	AgentRunner,
	FilteredIssueData,
	ParsedAgent,
	PipelineAgentResult,
	ProjectField,
	ProjectItem,
	SupervisorConfig,
} from "../../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitHubPort } from "../../github/ports.ts";
import type { TimeoutPolicy } from "../../config/config.ts";
import { executeAgent } from "../execute-agent.ts";
import { tryRebaseOntoBase } from "../rebase.ts";
import { GATE_HOOKS, type WorkflowStep } from "../../config/workflow.ts";
import { runTscAndLspAudit } from "../audit/index.ts";
import { validateAgentResult } from "../output.ts";
import { getRefusalInfo } from "../../agent/output.ts";
import {
	applyStatusTransition,
	applyGateFailureContext,
	buildAgentResultEntry,
	inferForwardStatus,
	preserveTimedOutWork,
	type PreservedWork,
	type StageState,
} from "../stages/index.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { RunContext } from "./shared.ts";

/**
 * Report a timed-out agent (issue #1987). Preserves a developer's partial work
 * as a pushed `wip(#N)` commit (fail-soft — a git failure is reported, never
 * thrown), notifies, logs the tier/base/effective/actual breakdown, and returns
 * the stopReason. Extracted from runAgentLoop (≤400-line skeleton).
 */
export async function reportTimedOutAgent(
	runCtx: RunContext,
	agentName: string,
	result: AgentRunResult,
	policy: TimeoutPolicy,
	nextStatus: string | null | undefined,
): Promise<string> {
	const { ctx, pi, config, issueNum, worktreePath, worktreeBranch, notify } = runCtx;
	let preserved: PreservedWork | undefined;
	if (agentName === "developer" && worktreePath && worktreeBranch) {
		// Mark preservation in flight BEFORE awaiting: crash cleanup reads this
		// live, so a SIGTERM during a bounded-but-stalled push retains the
		// worktree (preservationFailed is only set after the attempt returns).
		runCtx.preservationInProgress = true;
		try {
			preserved = await preserveTimedOutWork(
				pi,
				worktreePath,
				config.remote!,
				worktreeBranch,
				issueNum,
				notify,
				config.defaultBranch,
			);
		} finally {
			runCtx.preservationInProgress = false;
		}
	}
	// Preservation failed (e.g. push rejected): post-pipeline cleanup must keep
	// the worktree + branch, whose local commits are the only copy of the work.
	if (preserved && !preserved.committed && preserved.error) {
		runCtx.preservationFailed = true;
	}
	const preservedNote = preserved
		? preserved.committed
			? `, preserved ${preserved.files.length} file(s) as ${preserved.sha ?? "wip commit"}`
			: preserved.error
				? `, work preservation failed: ${preserved.error}`
				: ""
		: "";
	ctx.ui.notify(`Agent ${agentName} timed out. Pipeline stops.`, "warning");
	getDebugLogger().error("handler", "Agent timed out, pipeline stopping", {
		agentName,
		nextStatus,
		configuredTimeoutMs: result.configuredTimeoutMs,
		durationMs: result.durationMs,
		sizeTier: policy.sizeTier,
		baseTimeoutMs: policy.baseTimeoutMs,
		scale: policy.scale,
		preserved,
	});
	return `Agent ${agentName} timed out (configured ${Math.round((result.configuredTimeoutMs ?? policy.timeoutMs ?? 0) / 1000)}s, actual ${result.durationMs}ms; tier ${policy.sizeTier ?? "none"}, base ${policy.baseTimeoutMs ?? 0}ms, effective ${policy.timeoutMs ?? 0}ms${preservedNote})`;
}

/**
 * Pre-Implementation rebase (issue #1473): refresh the worktree onto the
 * latest default branch before a developer dispatch, so same-family PRs
 * landing mid-pipeline don't produce late PR-creation conflicts.
 *
 * Extracted from runAgentLoop (S138 ceiling) — the loop keeps only the
 * guarded call; policy lives here:
 * - Conflict → store files in stageState.rebaseConflictFiles (loop-scoped,
 *   survives Audit→Implementation loop-backs) and return the newline-joined
 *   file list as task context. The aborted rebase discards conflict markers,
 *   so the developer gets explicit merge-reintegration steps in the task.
 * - Success → clear stale conflict context.
 * - Non-conflict failure / exception → fail-open: warn via notify+collector,
 *   clear conflict context, proceed stale (end-rebase + merge handler remain
 *   the correctness backstop; a transient outage must not kill a 20-40min
 *   pipeline).
 *
 * mergeFallback:false — the `git merge --no-edit` fallback's unattributed
 * merge commit would count in hasBranchCommits base..head and pollute the
 * Bug #1343 empty-worktree classifier.
 *
 * @returns conflict context (newline-joined conflicted file paths) or undefined.
 */
export async function refreshWorktreeBeforeImplementation(
	runCtx: RunContext,
	worktreePath: string,
): Promise<string | undefined> {
	const { ctx, pi, config, collector, stageState } = runCtx;
	let rebaseConflictContext: string | undefined;
	try {
		const rebaseResult = await tryRebaseOntoBase(
			worktreePath,
			config.defaultBranch!,
			config.remote!,
			pi,
			{ mergeFallback: false },
		);
		if (rebaseResult.success) {
			stageState.rebaseConflictFiles = undefined;
			getDebugLogger().info("handler", "Pre-Implementation rebase OK — no conflicts");
		} else if (rebaseResult.conflictFiles.length > 0) {
			stageState.rebaseConflictFiles = rebaseResult.conflictFiles;
			rebaseConflictContext = rebaseResult.conflictFiles.join("\n");
			ctx.ui.notify(
				`Rebase conflicts with latest ${config.defaultBranch} in ${rebaseResult.conflictFiles.length} file(s) — developer will reintegrate main: ${rebaseResult.conflictFiles.join(", ")}`,
				"warning",
			);
		} else {
			// Non-conflict failure (fetch failed, index.lock, …) — fail-open:
			// proceed stale; end-rebase + merge handler remain the backstop.
			stageState.rebaseConflictFiles = undefined;
			ctx.ui.notify(
				`Cannot rebase onto latest ${config.defaultBranch}: ${rebaseResult.message} — proceeding with current base`,
				"warning",
			);
			collector?.push(
				"handler",
				"warn",
				`Pre-Implementation rebase failed (non-conflict): ${rebaseResult.message}`,
			);
		}
	} catch (rebaseErr: unknown) {
		const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
		stageState.rebaseConflictFiles = undefined;
		ctx.ui.notify(
			`Pre-Implementation rebase failed: ${rebaseMsg} — proceeding with current base`,
			"warning",
		);
		collector?.push("handler", "warn", `Pre-Implementation rebase failed: ${rebaseMsg}`);
	}
	return rebaseConflictContext;
}

/**
 * Execute the agent once, retry once on non-budget failure. Issue #1495
 * row order preserved: the validated failed run is pushed as its own
 * FAILED row BEFORE the retry row. budgetExceeded is NOT retryable (Neel
 * Mishra taxonomy); a refusal is NOT retried either (the refusal is the
 * definitive outcome regardless of process exit code — the handler's
 * refusal branch owns the stop). Pushes the final row; the skeleton does
 * audit-score tracking and the post-push tracing log.
 *
 * @returns the dispatch result after any retry, plus whether a retry ran.
 */
export async function dispatchAgentWithRetry(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number | null,
	worktreePath: string | undefined,
	config: SupervisorConfig,
	issueTitle: string,
	runner: AgentRunner | undefined,
	agentResults: PipelineAgentResult[],
	agentName: string,
): Promise<{ result: AgentRunResult; usedRetry: boolean }> {
	const { result: initialResult } = await executeAgent(
		agent,
		task,
		ctx,
		pi,
		timeoutMs,
		worktreePath,
		config.maxToolCalls,
		config.agentTokenBudget,
		issueTitle,
		runner,
		config.agentKillGraceSec,
	);
	let result = initialResult;
	let usedRetry = false;
	validateAgentResult(result);

	// Refusal short-circuit (audit fix): an agent that declined the task via
	// the documented `refusal` field has produced its definitive outcome even
	// when the process exited unsuccessfully (success=false, no budgetExceeded).
	// Retrying would replace the refusal with a fresh attempt, advance the
	// pipeline, or produce a different stop outcome — return the refusal
	// unchanged so the handler's refusal branch posts the note and stops.
	// Parse mirrors getRefusalInfo() in the dispatch skeleton and never
	// throws (unparseable output degrades to FailedParse → null).
	const refused = getRefusalInfo(result.textOutput, new Set(result.toolCalls ?? []));

	// Retry block: budget exceeded and wall-clock timeout are NOT retryable
	// (Neel Mishra taxonomy — a timed-out run already consumed its full
	// configured bound; retrying would silently double it), and a refusal is
	// not a failure to retry either.
	if (refused) {
		getDebugLogger().info("handler", `Agent ${agentName} refused — retry skipped`, {
			refused: true,
		});
	} else if (result.budgetExceeded) {
		getDebugLogger().info("handler", `Agent ${agentName} exceeded budget — retry skipped`, {
			budgetExceeded: true,
		});
	} else if (result.timedOut) {
		getDebugLogger().info("handler", `Agent ${agentName} timed out — retry skipped`, {
			timedOut: true,
			configuredTimeoutMs: result.configuredTimeoutMs,
		});
	} else if (!result.success) {
		getDebugLogger().info("handler", `Agent ${agentName} failed — retrying once`, {
			success: false,
		});
		const { result: retryResult } = await executeAgent(
			agent,
			task,
			ctx,
			pi,
			timeoutMs,
			worktreePath,
			config.maxToolCalls,
			config.agentTokenBudget,
			issueTitle,
			runner,
			config.agentKillGraceSec,
		);
		validateAgentResult(retryResult);
		usedRetry = true;
		// Issue #1495: push the validated failed run (FAILED row, own stats) before the retry row
		agentResults.push(buildAgentResultEntry(result, false, agent.config.model));
		result = retryResult;
	}

	getDebugLogger().info("handler", `Agent ${agentName} completed`, {
		success: result.success,
		usedRetry,
		durationMs: result.durationMs,
		toolCount: result.toolCount,
		tokenCount: result.tokenCount,
		budgetExceeded: result.budgetExceeded,
		summary: result.summaryLine?.slice(0, 200),
	});

	agentResults.push(buildAgentResultEntry(result, usedRetry, agent.config.model));

	return { result, usedRetry };
}

/**
 * Budget-exceeded degradation (issue #1495 semantics): researcher stops
 * researching and the pipeline continues to the next forward status
 * (posting a degradation comment when the run also failed); any other
 * agent stops the pipeline with an "exceeded budget" stop reason.
 * Returns a control-flow signal for the dispatch skeleton — this helper
 * never breaks/continues the caller's loop.
 */
export async function handleBudgetExceeded(
	result: AgentRunResult,
	agentName: string,
	step: WorkflowStep,
	port: GitHubPort,
	loopItem: ProjectItem,
	projectId: string,
	fields: ProjectField[],
	statusField: ProjectField,
	issueNum: number,
	config: SupervisorConfig,
	ctx: ExtensionCommandContext,
	collector: ErrorCollector,
	loopStatus: string,
): Promise<{ continue: true; loopStatus: string } | { continue: false; stopReason?: string }> {
	if (result.budgetExceeded) {
		// Graceful degradation: researcher stops researching, pipeline continues
		if (agentName === "researcher") {
			// When result.success is also true, handlePostAgentSuccess already posted
			// a combined comment (partial findings + "stopped early" header).
			// Skip separate comment here to avoid duplication.
			if (!result.success) {
				const budgetExceededMsg = `## Research Findings — Research stopped early: agent exceeded token budget (${result.tokenCount} tokens used). Pipeline continues without full research findings.`;
				try {
					await port.postIssueComment(issueNum, config.repo, budgetExceededMsg);
					ctx.ui.notify(`Posted researcher degradation notice on issue #${issueNum}`, "info");
				} catch (commentErr: unknown) {
					collector?.push(
						"handler",
						"warn",
						`Failed to post researcher degradation notice: ${
							commentErr instanceof Error ? commentErr.message : String(commentErr)
						}`,
					);
				}
			}
			const nextStatus = inferForwardStatus(step);
			if (nextStatus) {
				const nextLoopStatus = await applyStatusTransition(
					port,
					loopItem.id,
					projectId,
					fields,
					statusField.id,
					nextStatus,
				);
				ctx.ui.notify(
					`Issue #${issueNum} moved: Research → ${nextStatus} (researcher budget exceeded — graceful degradation)`,
					"info",
				);
				getDebugLogger().info("handler", `Research → ${nextStatus} (budget exceeded)`);
				return { continue: true, loopStatus: nextLoopStatus };
			}
		}
		const stopReason = `Agent ${result.agentName} exceeded budget (${result.toolCount} tools, ${result.tokenCount} tokens)`;
		getDebugLogger().warn("handler", "Budget exceeded", {
			agentName: result.agentName,
			toolCount: result.toolCount,
			tokenCount: result.tokenCount,
		});
		return { continue: false, stopReason };
	}
	return { continue: false };
}

/**
 * Pre-transition hooks (CI, TSC, LSP, duplicate code) — issue #787/#1407.
 * Runs the audit gate chain and returns the effective next status. Kept in
 * agent-loop.ts as the dispatch site for the gate hooks declared in
 * config/workflow.ts (GATE_HOOKS). Fail-open: hook exception → warn +
 * collector, proceed with the unmodified next status.
 */
export async function runPreTransitionHooks(
	step: WorkflowStep,
	nextStatus: string,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentName: string,
	loopFilteredData: FilteredIssueData,
	worktreePath: string | undefined,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	collector: ErrorCollector | undefined,
	stageState: StageState,
	iteration: number,
): Promise<string> {
	let effectiveNextStatus = nextStatus;
	if (step.hooks?.some((h) => GATE_HOOKS.includes(h))) {
		try {
			getDebugLogger().info("handler", "Running pre-transition hooks", {
				hooks: step.hooks,
			});
			const auditResult = await runTscAndLspAudit(
				issueNum,
				issueTitle,
				config,
				agentName,
				loopFilteredData,
				worktreePath!,
				pi,
				ctx,
				collector,
			);
			effectiveNextStatus = auditResult.nextStatus;
			// Capture gate failure context for developer feedback loop
			// When a pre-transition hook returns Implementation, the failure note
			// is stored so the next developer iteration receives targeted context.
			applyGateFailureContext(stageState, effectiveNextStatus, auditResult.note, iteration);

			// Surface gate failure to user so they know developer will re-dispatch
			// with the failure context injected into the next task prompt.
			if (effectiveNextStatus === "Implementation" && auditResult.note) {
				pi.sendMessage({
					customType: "supervisor",
					content: `## 🔴 Pre-Transition Gates Blocked — Returning to Developer\n\n${auditResult.note}\n\nFix issues above and the pipeline will retry automatically.`,
					display: true,
				});
				ctx.ui.notify(
					`Pre-transition gates blocked: ${auditResult.note.slice(0, 120)}… Re-dispatching developer.`,
					"warning",
				);
			}

			// Store dead code result in stage state for auditor context injection
			if (auditResult.deadCodeResult) {
				stageState.deadCodeResult = auditResult.deadCodeResult;
			}
			// Store duplicate code result in stage state for auditor context injection
			if (auditResult.duplicateCodeResult) {
				stageState.duplicateCodeResult = auditResult.duplicateCodeResult;
			}
			// Store vuln scan result in stage state for auditor context injection
			if (auditResult.vulnResult) {
				stageState.vulnResult = auditResult.vulnResult;
			}
			getDebugLogger().info("handler", "Pre-transition hook result", {
				effectiveNextStatus,
				note: auditResult.note,
			});
		} catch (auditErr: unknown) {
			const auditMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
			ctx.ui.notify(`Pre-audit error: ${auditMsg}`, "warning");
			collector?.push("handler", "warn", `Pre-transition hook error: ${auditMsg}`);
			getDebugLogger().error("handler", "Pre-transition hook error", {
				error: auditMsg,
			});
		}
	}
	return effectiveNextStatus;
}
