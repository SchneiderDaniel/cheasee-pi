// ─── Pipeline Handler Package: Entry ─────────────────────────────
// Split of the former 1139-line handler.ts (issue #1395).
// Orchestration only: entry gates → preflight → agent loop →
// post-pipeline, wrapped in the single top-level try/catch/finally
// (error funnel + lifecycle). RunContext lives in shared.ts so the
// phase modules stay import-cycle-free.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { preparePipelineContext, runPreflight } from "./preflight.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { runPostPipelinePhase } from "./post-pipeline.ts";
import { cleanupWorktree } from "../worktree.ts";
import { acquireRunLock, deleteCheckpointFile, releaseRunLock } from "../state-checkpoint.ts";
import { sendPipelineError } from "../notifications.ts";
import { getDebugLogger, resetDebugLogger } from "../../lib/debug.ts";

/**
 * Main supervisor handler — processes a GitHub issue through the full Kanban pipeline.
 * Supports --debug flag for structured JSONL logging to /tmp/.
 *
 * Mode adaptation: checks ctx.hasUI before calling dialog methods (confirm/select).
 * Trust gate: checks ctx.isProjectTrusted() before reading config or creating issues.
 * System prompt options: extracts via ctx.getSystemPromptOptions() for agent context.
 * Experimental features: gated behind config.enableExperimentalFeatures.
 */
export async function handleSupervisorCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	await runSupervisorPipeline(args, ctx, pi);
}

/**
 * Pipeline orchestration: preflight → agent loop → post-pipeline with a
 * single top-level try/catch/finally. The entry gates (trust check, arg
 * parsing, debug setup) run before the try — matching the pre-refactor
 * control flow where an untrusted project or bad args return without
 * hitting the finally block. Package-private: only handleSupervisorCommand
 * dispatches the pipeline (the barrel exports the command entry, not the
 * orchestrator).
 */
async function runSupervisorPipeline(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const runCtx = preparePipelineContext(args, ctx, pi);
	if (!runCtx) return;

	try {
		// One pipeline per repo — a concurrent run would race on the same
		// worktree path (second run reuses the live worktree, first finisher
		// removes it under the other's agent). Refuse to start instead.
		const lockRes = acquireRunLock(runCtx.ctx.cwd, runCtx.issueNum);
		if (!lockRes.ok) {
			runCtx.collector.push("handler", "error", lockRes.error);
			runCtx.ctx.ui.notify(`Pipeline blocked: ${lockRes.error}`, "error");
			getDebugLogger().error("handler", "Run lock not acquired", { error: lockRes.error });
			return;
		}
		if (!(await runPreflight(runCtx))) return;
		await runAgentLoop(runCtx);
		await runPostPipelinePhase(runCtx);
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("handler", "Pipeline threw unhandled error", { error: errMsg });
		runCtx.collector.push("handler", "error", `Pipeline threw unhandled error: ${errMsg}`);
		// Also cleanup on error
		if (runCtx.worktreePath && runCtx.worktreeBranch) {
			const cleanResult = await cleanupWorktree(
				runCtx.pi,
				runCtx.ctx.cwd,
				runCtx.worktreePath,
				runCtx.worktreeBranch,
				runCtx.notify,
			);
			if (!cleanResult.ok) {
				getDebugLogger().warn("handler", `Worktree cleanup on error failed: ${cleanResult.error}`);
			}
		}
		// Delete checkpoint file on error (idempotent)
		{
			const delResult = deleteCheckpointFile(runCtx.ctx.cwd);
			if (!delResult.ok) {
				getDebugLogger().warn(
					"handler",
					`Failed to delete checkpoint on error: ${delResult.error}`,
				);
			}
		}
		sendPipelineError(
			runCtx.pi,
			runCtx.ctx,
			runCtx.agentResults,
			runCtx.issueNum,
			runCtx.issueTitle,
			runCtx.config,
			errMsg,
		);
	} finally {
		// Release the run lock (idempotent — only removed if we own it)
		releaseRunLock(runCtx.ctx.cwd);

		// Clear supervisor issue data from footer (any outcome)
		// Uses shared pi.events bus instead of dynamic import.
		pi.events.emit("supervisor:issue-data", null);

		// Teardown signal handlers so they don't leak beyond pipeline
		if (runCtx.crashCleanup) {
			runCtx.crashCleanup.teardown();
			getDebugLogger().info("handler", "Crash cleanup handlers removed");
		}
		if (runCtx.isDebug) {
			const logPath = getDebugLogger().getLogPath();
			ctx.ui.notify(`Debug log: ${logPath}`, "info");
			resetDebugLogger();
		}
	}
}

// Re-export for path-coupled callers importing from "pipeline/handler.ts"
// (the shim) and for the handler package barrel.
export { handlePostPipeline } from "./post-pipeline.ts";
