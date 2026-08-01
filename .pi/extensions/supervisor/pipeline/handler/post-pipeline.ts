// ─── Pipeline Handler Package: Post-Pipeline ─────────────────────
// Runs after the agent loop (issue #1395 split of handler.ts):
//   - handlePostPipeline: merge resolution → worktree cleanup →
//     checkpoint deletion, in try/finally so cleanup always runs.
//   - runPostPipelinePhase: the completion notification funnel
//     (sendPipelineSummary / status clear).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	PrCreationResult,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { NotifyFn } from "../helpers.ts";
import { isDoneStatus } from "../stages.ts";
import { handlePostPipelineMerge } from "../merge.ts";
import { cleanupWorktree } from "../worktree.ts";
import { deleteCheckpointFile } from "../state-checkpoint.ts";
import { sendPipelineSummary } from "../notifications.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { RunContext } from "./shared.ts";

// ─── Completion notification (consumes final RunContext state) ───

export async function runPostPipelinePhase(runCtx: RunContext): Promise<void> {
	// Post-pipeline operations with correct ordering:
	// 1. Merge resolution (needs worktree to exist)
	// 2. Worktree cleanup (after merge is complete)
	const unresolvedConflicts = await handlePostPipeline(
		runCtx.issueNum,
		runCtx.issueTitle,
		runCtx.loopStatus,
		runCtx.agentResults,
		runCtx.config,
		runCtx.pi,
		runCtx.ctx,
		runCtx.worktreePath,
		runCtx.worktreeBranch,
		runCtx.prCreationResult,
		runCtx.isDebug,
		runCtx.collector,
		runCtx.notify,
		runCtx.port,
	);

	// Completion notification
	if (runCtx.agentResults.length > 0 || runCtx.stopReason !== undefined) {
		// Compute overall status considering PR creation result
		// If loop reached Done but PR creation failed, still report as "success"
		// with a PR-creation-failure note (Bug 4 fix)
		const overallStatus: "success" | "failed" | "stopped" = isDoneStatus(runCtx.loopStatus)
			? "success"
			: runCtx.agentResults.some((a) => a.status === "FAILED")
				? "failed"
				: "stopped";
		sendPipelineSummary(
			runCtx.pi,
			runCtx.ctx,
			runCtx.agentResults,
			overallStatus,
			runCtx.issueNum,
			runCtx.issueTitle,
			runCtx.config,
			runCtx.stopReason,
			runCtx.prCreationResult,
			runCtx.collector,
			runCtx.stageState.gateFailureHistory,
			undefined,
			unresolvedConflicts,
		);
		getDebugLogger().info("handler", "Pipeline finished", {
			overallStatus,
			agentCount: runCtx.agentResults.length,
			stopReason: runCtx.stopReason,
			totalDurationMs: runCtx.agentResults.reduce((s, a) => s + a.durationMs, 0),
		});
	} else {
		runCtx.ctx.ui.setStatus("supervisor", undefined);
	}
}

// Extracted for testability — runs merge before cleanup.
// Order: merge (needs worktree) → cleanup (deletes worktree).
// In try/finally so cleanup always runs even if merge throws.
// When debug is active and PR creation failed, worktree is preserved
// for post-hoc inspection (Bug 7 fix).

export async function handlePostPipeline(
	issueNum: number,
	issueTitle: string,
	loopStatus: string,
	agentResults: PipelineAgentResult[],
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	prCreationResult?: PrCreationResult,
	isDebug?: boolean,
	collector?: ErrorCollector,
	notify?: NotifyFn,
	port?: GitHubPort,
): Promise<boolean> {
	let unresolvedConflicts = false;

	try {
		// Step 1: Post-pipeline merge resolution — needs worktree to exist
		if (isDoneStatus(loopStatus) && agentResults.length > 0) {
			unresolvedConflicts = await handlePostPipelineMerge(
				issueNum,
				issueTitle,
				loopStatus,
				config,
				pi,
				ctx,
				worktreePath,
				collector,
				undefined,
				port,
			);
		}
	} finally {
		// Step 2: Worktree cleanup — always runs, even if merge throws
		// Exception: preserve worktree on PR failure when debug is active
		// (Bug 7 fix — keeps evidence for post-hoc debugging)
		if (worktreePath && worktreeBranch) {
			const prFailed = prCreationResult && !prCreationResult.success;
			if (unresolvedConflicts) {
				const log = getDebugLogger();
				log.warn("handler", "Merge resolution failed — preserving worktree");
				ctx.ui.notify(
					`Merge conflicts remain in PR #${issueNum}. Worktree preserved at ${worktreePath} for manual resolution.`,
					"error",
				);
			} else if (isDebug && prFailed) {
				const log = getDebugLogger();
				log.info("handler", "PR creation failed in debug mode — preserving worktree", {
					worktreePath,
					branch: worktreeBranch,
				});
				ctx.ui.notify(
					`PR creation failed. Worktree preserved at ${worktreePath} for inspection.`,
					"warning",
				);
			} else {
				const cleanResult = await cleanupWorktree(
					pi,
					ctx.cwd,
					worktreePath,
					worktreeBranch,
					notify ||
						({
							info: () => {},
							error: () => {},
						} as NotifyFn),
				);
				if (!cleanResult.ok) {
					getDebugLogger().warn("handler", `Worktree cleanup failed: ${cleanResult.error}`);
				}
			}
		}
		// Delete checkpoint file on pipeline completion (idempotent)
		const delResult = deleteCheckpointFile(ctx.cwd);
		if (!delResult.ok) {
			getDebugLogger().warn("handler", `Failed to delete checkpoint: ${delResult.error}`);
		}
	}
	return unresolvedConflicts;
}
