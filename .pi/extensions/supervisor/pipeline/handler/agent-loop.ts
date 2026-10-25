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
// Issue #2005 moved the per-iteration policy helpers
// (reportTimedOutAgent, refreshWorktreeBeforeImplementation,
// dispatchAgentWithRetry, handleBudgetExceeded, runPreTransitionHooks) to
// agent-loop-helpers.ts — their call sites stay here.
// Source pins (agent-loop-split.test.mts / handler-structure.test.mts,
// agent-loop-rebase.test.mts / pipeline-worktree-integration.test.mts)
// are split across agent-loop.ts, agent-loop-steps.ts and
// agent-loop-helpers.ts — see #1866/#2005.
// Each `// ─── <concern> ───` marker in runAgentLoop labels one extracted
// helper call.

import { resolveTimeoutPolicy } from "../../config/config.ts";
import { parseSizeTier } from "../../lib/size-tier.ts";
import {
	MAX_PIPELINE_LOOPS,
	calculateNextStatus,
	applyStatusTransition,
	handlePostAgentSuccess,
	handleEmptyWorktree,
	type EmptyWorktreeOutcome,
} from "../stages/index.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { RunContext } from "./shared.ts";
import {
	dispatchAgentWithRetry,
	handleBudgetExceeded,
	refreshWorktreeBeforeImplementation,
	reportTimedOutAgent,
	runPreTransitionHooks,
} from "./agent-loop-helpers.ts";
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
		// timeout) → agentTimeoutsMin (legacy minutes) → 30-min default ×
		// size-tier scale (issue #1987; large ×2 → 60 min).
		const sizeTier = parseSizeTier(loopFilteredData.comments);
		const timeoutPolicy = resolveTimeoutPolicy(agentName, config, sizeTier);
		const timeoutMs = timeoutPolicy.timeoutMs;

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
		const task = await assembleAgentTask(
			runCtx,
			agentName,
			loopFilteredData,
			rebaseConflictContext,
		);

		getDebugLogger().info("handler", `Dispatching agent ${agentName}`, {
			model: agent.config.model,
			timeoutMs,
			sizeTier,
			baseTimeoutMs: timeoutPolicy.baseTimeoutMs,
			scale: timeoutPolicy.scale,
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
			stopReason = await reportTimedOutAgent(
				runCtx,
				agent.config.name,
				result,
				timeoutPolicy,
				nextStatus,
			);
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
