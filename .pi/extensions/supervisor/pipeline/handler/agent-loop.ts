// ─── Pipeline Handler Package: Agent Loop ────────────────────────
// The MAX_PIPELINE_LOOPS stage machine (issue #1395 split of handler.ts;
// issue #1886 extracted the per-iteration concerns). Iterates Backlog →
// Research → Architecture → TestDesign → Implementation → Audit → Done,
// incl. PR creation on approval, budget-exceeded degradation,
// empty-worktree classification and pre-transition hooks.
//
// runAgentLoop is intentionally a dispatch skeleton rather than a ≤100-line
// function: it owns the loop primitives (loopStatus / stopReason /
// prCreationResult) and translates each helper's signal into a break/continue
// (S138 exemption contract, ≤800; issue #1886 target ≤400). The per-iteration
// concerns live in the sibling module agent-loop-steps.ts (resolveStep,
// runBacklogStep, runDoneStep, resolveLoopAgent, loadLoopIssue,
// runResearcherDedupGate, writePreAuditorCheckpoint, loadLoopAgentFile,
// assembleAgentTask, recordPostDispatch).
//
// Unpinned per-stage logic lives in stages/ (empty-worktree.ts,
// auditor-output.ts, git-ops.ts) and handler/pr-gates.ts
// (handlePrApprovalFlow). Same-file helpers below are ≤100 lines each.
// Source pins (agent-loop-split.test.mts / handler-structure.test.mts,
// agent-loop-rebase.test.mts / pipeline-worktree-integration.test.mts)
// are split across agent-loop.ts and agent-loop-steps.ts — see #1866.
// Each `// ─── <concern> ───` marker in runAgentLoop labels one extracted
// helper call.

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
import { resolveTimeoutPolicy } from "../../config/config.ts";
import { executeAgent } from "../execute-agent.ts";
import { tryRebaseOntoBase } from "../rebase.ts";
import { GATE_HOOKS, type WorkflowStep } from "../../config/workflow.ts";
import { runTscAndLspAudit } from "../audit/index.ts";
import { validateAgentResult } from "../output.ts";
import { getRefusalInfo } from "../../agent/output.ts";
import {
	MAX_PIPELINE_LOOPS,
	calculateNextStatus,
	applyStatusTransition,
	inferForwardStatus,
	buildAgentResultEntry,
	handlePostAgentSuccess,
	applyGateFailureContext,
	handleEmptyWorktree,
	type EmptyWorktreeOutcome,
	type StageState,
} from "../stages/index.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { RunContext } from "./shared.ts";
import { handlePrApprovalFlow } from "./pr-gates.ts";
import {
	assembleAgentTask,
	loadLoopAgentFile,
	loadLoopIssue,
	recordPostDispatch,
	resolveLoopAgent,
	resolveStep,
	runBacklogStep,
	runDoneStep,
	runResearcherDedupGate,
	writePreAuditorCheckpoint,
} from "./agent-loop-steps.ts";

/**
 * Runs the pipeline loop until a terminal status, stop reason or budget
 * exhaustion. Mutates runCtx in place (agentResults, stageState, loopStatus,
 * stopReason, prCreationResult) — the post-pipeline phase reads the final
 * state from the same context.
 */
export async function runAgentLoop(runCtx: RunContext): Promise<void> {
	const {
		ctx,
		pi,
		config,
		issueNum,
		issueTitle,
		worktreePath,
		worktreeBranch,
		notify,
		collector,
		port,
		stageState,
		agentResults,
		loopItem,
		fields,
		statusField,
		projectId,
	} = runCtx;
	let loopStatus = runCtx.loopStatus;
	let stopReason = runCtx.stopReason;
	let prCreationResult = runCtx.prCreationResult;

	for (let i = 0; i < MAX_PIPELINE_LOOPS; i++) {
		ctx.ui.setStatus("supervisor", `Status: ${loopStatus}`);
		ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");
		getDebugLogger().info("handler", `Pipeline iteration ${i + 1}`, {
			loopStatus,
			iteration: i,
		});

		// ─── Resolve workflow step ───
		const stepResolution = resolveStep(runCtx, loopStatus);
		if (stepResolution.kind === "terminal") {
			stopReason = stepResolution.stopReason;
			break;
		}
		const step = stepResolution.step;

		// ─── Backlog step (builtIn checks precede agent resolution) ───
		const backlogStatus = await runBacklogStep(runCtx, step);
		if (backlogStatus) {
			loopStatus = backlogStatus;
			continue;
		}

		// ─── Done step ───
		if (runDoneStep(runCtx, step)) {
			break;
		}

		// ─── Resolve agent ───
		const agentResolution = resolveLoopAgent(runCtx, loopStatus);
		if (agentResolution.kind === "terminal") {
			stopReason = agentResolution.stopReason;
			break;
		}
		const agentName = agentResolution.agentName;

		// ─── Fetch fresh issue data + rejection limit ───
		const issueResolution = await loadLoopIssue(runCtx, step);
		if (issueResolution.kind === "terminal") {
			stopReason = issueResolution.stopReason;
			break;
		}
		const loopFilteredData = issueResolution.data;

		// ─── Deduplication gate (rejection limit precedes it) ───
		const dedup = await runResearcherDedupGate(
			runCtx,
			step,
			loopStatus,
			agentName,
			loopFilteredData,
		);
		if (dedup.kind === "advanced") {
			loopStatus = dedup.loopStatus;
			continue;
		}

		// ─── Pre-auditor checkpoint ───
		writePreAuditorCheckpoint(runCtx, agentName);

		// ─── Load agent file ───
		const agentFile = await loadLoopAgentFile(runCtx, agentName);
		if (agentFile.kind === "missing") {
			stopReason = agentFile.stopReason;
			break;
		}
		const agent = agentFile.agent;

		ctx.ui.setStatus("supervisor", `Running ${agent.config.name}...`);
		ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");
		// Per-agent wall-clock timeout: agentTimeoutSec (seconds, 0 = no
		// timeout) → agentTimeoutsMin (legacy minutes) → 30-min default.
		const timeoutMs = resolveTimeoutPolicy(agentName, config).timeoutMs;

		// Pre-Implementation rebase (issue #1473) — policy lives in the helper.
		// Refresh the worktree onto the latest default branch before every
		// developer dispatch (incl. Audit→Implementation loop-backs), so
		// same-family PRs landing mid-pipeline don't produce late PR-creation
		// conflicts. Policy lives in refreshWorktreeBeforeImplementation
		// (mergeFallback:false, fail-open on network failure; the end-rebase at
		// PR creation remains the backstop).
		const rebaseConflictContext =
			agentName === "developer" && worktreePath && worktreeBranch
				? await refreshWorktreeBeforeImplementation(runCtx, worktreePath)
				: undefined;

		// ─── Assemble task ───
		const task = assembleAgentTask(runCtx, agentName, loopFilteredData, rebaseConflictContext);

		getDebugLogger().info("handler", `Dispatching agent ${agentName}`, {
			model: agent.config.model,
			timeoutMs,
			taskLen: task.length,
			cwdOverride: worktreePath,
		});

		// Execute agent (initial attempt + bounded retry). budgetExceeded is
		// NOT retryable; issue #1495 failed-row push order preserved inside.
		const { result, usedRetry } = await dispatchAgentWithRetry(
			agent,
			task,
			ctx,
			pi,
			timeoutMs,
			worktreePath,
			config,
			issueTitle,
			runCtx._runner,
			agentResults,
			agentName,
		);

		// ─── Post-dispatch bookkeeping: trace, audit score, gate, refusal ───
		const { gateRejected, refusedOutput } = recordPostDispatch(runCtx, agentName, result, i);

		// Post-processing — pass pre-computed gateRejected so auditor
		// comment posting can show gate rejection instead of approval
		if (result.success && !refusedOutput) {
			const continuePipeline = await handlePostAgentSuccess(
				pi,
				ctx,
				result,
				agentName,
				issueNum,
				config,
				loopFilteredData,
				worktreePath,
				worktreeBranch,
				issueTitle,
				collector,
				gateRejected,
				notify,
				port,
			);
			if (!continuePipeline) {
				stopReason = `commitAndPush failed for ${agentName}`;
				getDebugLogger().error("handler", "commitAndPush failed", { agentName });
				break;
			}
		}

		// Determine next status — pass result.success so inferForwardStatus
		// is skipped on agent failure (Bug #643 fix).
		// hadExplicitMarker tracks whether the status came from agent output
		// (structured JSON or text marker) vs. pipeline inference (Bug #711 fix).
		// For auditor, pass audit context with researcherSkipped and scoreThreshold
		// so the audit score gate (Bug #648 fix) can evaluate independently.
		// Note: gateRejected may already be computed above; calculateNextStatus
		// re-computes it deterministically — this is fine (<1ms overhead).
		const auditContext =
			agentName === "auditor"
				? {
						researcherSkipped: stageState.researcherSkipped,
						scoreThreshold: config.auditScoreThreshold ?? 0.75,
					}
				: undefined;
		const {
			status: nextStatus,
			stopReason: nsStop,
			hadExplicitMarker = false,
			refusal,
		} = calculateNextStatus(
			agentName,
			result.textOutput,
			result.textOnly,
			result.success,
			auditContext,
			new Set(result.toolCalls ?? []),
		);

		getDebugLogger().info("handler", "Next status determined", {
			nextStatus,
			stopReason: nsStop,
		});

		// Timeout is an UNCONDITIONAL terminal failure (audit finding #3): a
		// timed-out agent may have emitted a partial completion/approval
		// marker before the deadline fired. Letting it through the Bug #711
		// explicit-marker guard would advance the pipeline on partial output
		// — a timed-out developer could transition Research→…→Audit or a
		// timed-out auditor to Done despite success=false. Stop before ANY
		// marker-based transition (empty-worktree, PR-approval, budget
		// degradation), naming the agent + configured duration.
		if (result.timedOut) {
			stopReason = `Agent ${agent.config.name} timed out (configured ${Math.round((result.configuredTimeoutMs ?? 0) / 1000)}s, actual ${result.durationMs}ms)`;
			ctx.ui.notify(`Agent ${agent.config.name} timed out. Pipeline stops.`, "warning");
			getDebugLogger().error("handler", "Agent timed out, pipeline stopping", {
				agentName: agent.config.name,
				nextStatus,
				configuredTimeoutMs: result.configuredTimeoutMs,
				durationMs: result.durationMs,
			});
			break;
		}

		// Bug #1343: 3-way empty worktree classification (extracted to
		// stages/empty-worktree.ts): when developer produced no commits,
		// loop back to Implementation / close with named resolution /
		// leave open for PR review. { stop: true } → break.
		if (agentName === "developer" && nextStatus === "Audit" && worktreePath && result.success) {
			const outcome: EmptyWorktreeOutcome = await handleEmptyWorktree(
				pi,
				ctx,
				config,
				port,
				collector,
				issueNum,
				worktreePath,
				worktreeBranch,
			);
			if (outcome.stop) {
				stopReason = outcome.stopReason;
				break;
			}
		}

		// PR creation on audit approval — capture result for completion summary
		// (Bug 2, Bug 6 fix: propagate PR creation result to caller). Blocked
		// gate → non-Done status + stop (handler/pr-gates.ts).
		if (agentName === "auditor" && result.success && nextStatus === "Done") {
			const prFlow = await handlePrApprovalFlow(runCtx, loopStatus);
			prCreationResult = prFlow.prCreationResult;
			if (prFlow.stop) {
				stopReason = prFlow.stopReason;
				loopStatus = prFlow.loopStatus;
				break;
			}
		}

		// Budget-exceeded degradation: researcher stops researching and the
		// pipeline continues (graceful), any other agent stops the pipeline.
		// Skipped entirely when the agent refused — a refusal is a deliberate
		// stop handled by the !nextStatus branch below (posts the refusal note
		// and breaks). Without this guard a budget-exceeded researcher refusal
		// would post the degradation notice, transition Research → Architecture
		// and continue the loop, never reaching the refusal branch (audit fix).
		if (!refusedOutput) {
			const budgetOutcome = await handleBudgetExceeded(
				result,
				agentName,
				step,
				port,
				loopItem,
				projectId,
				fields,
				statusField,
				issueNum,
				config,
				ctx,
				collector,
				loopStatus,
			);
			if (budgetOutcome.continue) {
				loopStatus = budgetOutcome.loopStatus;
				continue;
			}
			if (budgetOutcome.stopReason) {
				stopReason = budgetOutcome.stopReason;
				break;
			}
		}

		// Bug #711: Replace status-based failure guard with explicit-marker check.
		// Old guard: !result.success && nextStatus !== "Audit" — only worked for auditor
		// step because developer's only forward marker IS "Audit".
		// New guard: if agent failed AND no explicit marker in its output → stop.
		// Explicit marker means structured JSON action or text marker match,
		// NOT inferForwardStatus (which is pipeline inference, not agent output).
		// This prevents the crash-loop: developer crashes (0 tokens, 0 tools),
		// inferForwardStatus returns "Audit", hadExplicitMarker=false → stop.
		// result.timedOut already stopped unconditionally above (terminal
		// failure) — this guard covers remaining non-timeout failures.
		if (!result.success && !hadExplicitMarker) {
			stopReason = `Agent ${agent.config.name} failed — no explicit completion marker in output`;
			ctx.ui.notify(`Agent ${agent.config.name} failed. Pipeline stops.`, "warning");
			getDebugLogger().error("handler", "Agent failed, pipeline stopping (no explicit marker)", {
				agentName: agent.config.name,
				nextStatus,
				timedOut: result.timedOut,
			});
			break;
		}

		if (!nextStatus) {
			// Refusal: the agent declined the task via the documented `refusal`
			// field. Post the reason (agent commentBody when supplied, otherwise a
			// generated note) before stopping — a refusal is never a transition.
			if (refusal) {
				// Blank/whitespace-only commentBody is treated as absent — an empty
				// comment would lose the refusal reason entirely. Trim is for blank
				// detection only: non-blank bodies are posted verbatim (leading /
				// trailing whitespace and markdown preserved — audit fix).
				const supplied = refusal.commentBody;
				const body =
					supplied !== undefined && supplied.trim().length > 0
						? supplied
						: `## Agent Refused\n\nThe \`${refusal.agentName ?? agent.config.name}\` agent declined this task:\n\n> ${refusal.refusal || "_no reason provided_"}\n\nPipeline stops here.`;
				try {
					await port.postIssueComment(issueNum, config.repo, body);
					ctx.ui.notify(`Agent ${agent.config.name} refused — posted refusal comment.`, "warning");
				} catch (err: unknown) {
					collector?.push(
						"handler",
						"warn",
						`Failed to post refusal comment: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			stopReason = nsStop || `Agent ${agent.config.name} output unclear`;
			ctx.ui.notify(stopReason, "warning");
			getDebugLogger().warn("handler", "No next status from agent output", {
				agentName: agent.config.name,
				stopReason,
			});
			break;
		}

		if (step.canLoopBackTo?.includes(nextStatus)) {
			ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
			getDebugLogger().info("handler", "Feedback loop", { from: loopStatus, to: nextStatus });
		}

		// Pre-transition hooks (CI, TSC, LSP, duplicate code)
		const effectiveNextStatus = await runPreTransitionHooks(
			step,
			nextStatus,
			issueNum,
			issueTitle,
			config,
			agentName,
			loopFilteredData,
			worktreePath,
			pi,
			ctx,
			collector,
			stageState,
			i + 1,
		);

		// Status transition
		try {
			const prev = loopStatus;
			loopStatus = await applyStatusTransition(
				port,
				loopItem.id,
				projectId,
				fields,
				statusField.id,
				effectiveNextStatus,
			);
			ctx.ui.notify(`Issue #${issueNum} moved: ${prev} → ${loopStatus}`, "info");
			ctx.ui.setStatus("supervisor", `Status: ${loopStatus}`);
			getDebugLogger().info("handler", "Status transition applied", {
				from: prev,
				to: loopStatus,
			});
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			stopReason = `Failed to update status: ${errMsg}`;
			ctx.ui.notify(stopReason, "error");
			collector?.push("handler", "error", `Status transition failed: ${errMsg}`);
			getDebugLogger().error("handler", "Status transition failed", {
				error: errMsg,
			});
			break;
		}
	}

	// Write back loop-scoped state so the post-pipeline phase observes it.
	runCtx.loopStatus = loopStatus;
	runCtx.stopReason = stopReason;
	runCtx.prCreationResult = prCreationResult;
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
async function refreshWorktreeBeforeImplementation(
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
 * @returns final result (post-retry) + whether a retry was used.
 */
async function dispatchAgentWithRetry(
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
async function handleBudgetExceeded(
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
async function runPreTransitionHooks(
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
