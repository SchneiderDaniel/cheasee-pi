// ─── Pipeline Merge: Conflict Resolution ──────────────────────────
// Split out of merge.ts (issue #2005 Long File refactor). Auto-merge →
// push → bounded developer-dispatch sequence shared by the pre-Done gate
// (pr-gate.ts) and the post-Done backstop (merge.ts). merge.ts re-exports
// resolveBranchConflicts so the pipeline surface is unchanged.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunner, AgentRunResult } from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { tryAutoMerge } from "../config/merge.ts";
import { runAgentSubprocess } from "../agent/runner.ts";
import { resolveTimeoutPolicy } from "../config/config.ts";
import { parseAgentFile } from "../agent/loader.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";

// ─── Conflict Resolution ──────────────────────────────────────────
// Shared auto-merge → push → developer-dispatch sequence used by both
// the pre-Done gate and the post-Done backstop. Returns whether the
// branch is resolved and whether the developer was dispatched.
function devConflictStatusLabel(result: AgentRunResult): "SUCCESS" | "TIMEOUT" | "FAILED" {
	if (result.success) return "SUCCESS";
	if (result.timedOut) return "TIMEOUT";
	return "FAILED";
}

export async function resolveBranchConflicts(
	issueNum: number,
	branch: string,
	prNumber: number | undefined,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath?: string,
	collector?: ErrorCollector,
	runner?: AgentRunner,
	rebaseConflicts?: string[],
): Promise<{ ok: boolean; devDispatched: boolean; note?: string }> {
	const log = getDebugLogger();
	const wt = worktreePath ?? resolvePath(ctx.cwd || process.cwd(), config.worktreeBase!, branch);

	ctx.ui.setStatus("supervisor", "Attempting auto-merge...");
	log.info("pipeline-merge", "Attempting auto-merge", { wt, branch });
	const mergeResult = await tryAutoMerge(wt, branch, config.defaultBranch!, config.remote!, pi);
	log.info("pipeline-merge", `Auto-merge result: success=${mergeResult.success}`, {
		conflictFiles: mergeResult.conflictFiles,
		message: mergeResult.message,
	});

	if (mergeResult.success) {
		try {
			log.info("pipeline-merge", "Pushing resolved merge");
			const pushResult = await pi.exec("git", ["push", config.remote!, branch], {
				cwd: wt,
				timeout: 30_000,
			});
			if (pushResult.code !== 0) {
				throw new Error(pushResult.stderr || pushResult.stdout || "git push failed");
			}
			log.info("pipeline-merge", "Merge resolved and pushed");
			ctx.ui.notify("Merge conflicts resolved and pushed!", "info");
			pi.sendMessage({
				customType: "supervisor",
				content: `## ✅ Merge Conflicts Resolved\n\nConflicts on ${branch} were resolved automatically and pushed.`,
				display: true,
			});
			return { ok: true, devDispatched: false };
		} catch (pushErr: unknown) {
			const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
			log.error("pipeline-merge", `Merge succeeded but push failed: ${msg}`);
			ctx.ui.notify(`Merge succeeded but push failed: ${msg}`, "error");
			collector?.push("merge", "error", `Merge succeeded but push failed: ${msg}`);
			return { ok: false, devDispatched: false, note: `Merge succeeded but push failed: ${msg}` };
		}
	}

	log.info("pipeline-merge", "Auto-merge failed, dispatching developer");
	ctx.ui.notify(
		`Auto-merge failed: ${mergeResult.message}. Dispatching developer to resolve...`,
		"warning",
	);

	const conflictFiles =
		mergeResult.conflictFiles.length > 0 ? mergeResult.conflictFiles : (rebaseConflicts ?? []);
	const prLabel = prNumber ? `PR #${prNumber}` : `issue #${issueNum}`;
	const devTask = [
		`## Task: Resolve Merge Conflicts`,
		``,
		`**Branch:** ${branch}`,
		`**Worktree:** ${wt}`,
		`**Base branch:** ${config.defaultBranch}`,
		`**Conflicted files:** ${conflictFiles.join(", ") || "(unknown)"}`,
		``,
		`### Steps`,
		`1. Enter worktree: \`cd ${wt}\``,
		`2. Fetch base: \`git fetch ${config.remote} ${config.defaultBranch}\``,
		`3. Merge base: \`git merge ${config.remote}/${config.defaultBranch}\``,
		`4. Resolve conflicts in the conflicted files`,
		`5. Stage resolved files: \`git add -A\``,
		`6. Commit merge: \`git commit -m "fix: resolve merge conflicts for ${prLabel}"\``,
		`7. Push: \`git push ${config.remote} ${branch}\``,
		``,
		`When done, output CONFLICTS_RESOLVED on its own line.`,
	].join("\n");

	// Dispatch developer via subprocess for consistent widget rendering.
	// Per-agent timeout via the shared resolver (agentTimeoutSec.developer
	// wins over legacy agentTimeoutsMin.developer; configured 0 → null =
	// no timeout — the old truthiness check silently turned 0 into the
	// 30-min default).
	log.info("pipeline-merge", "Dispatching developer for conflict resolution");
	try {
		const agentPath = resolvePath(wt, ".pi/extensions/supervisor/agents/developer.md");
		const { existsSync } = await import("node:fs");
		if (!existsSync(agentPath)) {
			throw new Error(`Agent file not found: ${agentPath}`);
		}
		const developerAgent = parseAgentFile(agentPath);

		const devTimeoutPolicy = resolveTimeoutPolicy("developer", config);

		const devResult = await (runner ?? runAgentSubprocess)({
			agent: developerAgent,
			task: devTask,
			ctx,
			timeoutMs: devTimeoutPolicy.timeoutMs,
			cwd: wt,
			maxToolCalls: config.maxToolCalls,
			agentTokenBudget: config.agentTokenBudget,
			killGraceSec: config.agentKillGraceSec,
		});

		const devSuccess = devResult.success;
		// Timeout metadata is user-visible on this path too (audit #4): name the
		// agent, the configured duration and the actual duration, and carry the
		// runner's errorOutput (which already holds the structured [Timeout: …]
		// note) so a timed-out dispatch is never reported as a bare FAILED.
		const devStatusLabel = devConflictStatusLabel(devResult);
		const devDetailText = [devResult.summaryLine || "", devResult.errorOutput || ""]
			.filter((line) => line.trim().length > 0)
			.join("\n\n");

		log.info("pipeline-merge", `Developer conflict resolution: success=${devSuccess}`, {
			timedOut: devResult.timedOut,
			configuredTimeoutMs: devResult.configuredTimeoutMs,
			durationMs: devResult.durationMs,
		});

		pi.sendMessage({
			customType: "supervisor",
			content: `## Conflict Resolution: developer — ${devStatusLabel}\n\n${devDetailText}`,
			display: true,
			details: {
				eventType: "subagent-result",
				agentName: "developer",
				timedOut: devResult.timedOut,
				configuredTimeoutMs: devResult.configuredTimeoutMs,
				content: [
					{
						type: "text",
						text: devResult.errorOutput || devResult.textOutput || "",
					},
				],
				details: {
					agentName: "developer",
					success: devSuccess,
					statusLabel: devStatusLabel,
					summaryLine: devResult.summaryLine || "",
					errorOutput: devResult.errorOutput || undefined,
					timedOut: devResult.timedOut,
					configuredTimeoutMs: devResult.configuredTimeoutMs,
					durationMs: devResult.durationMs,
				},
			},
		});

		if (devSuccess) {
			log.info("pipeline-merge", "Developer resolved conflicts");
			ctx.ui.notify("Developer resolved merge conflicts successfully!", "info");
			return { ok: true, devDispatched: true };
		}
		log.warn("pipeline-merge", "Developer failed to resolve conflicts");
		ctx.ui.notify("Developer failed to resolve conflicts. Manual intervention required.", "error");
		return {
			ok: false,
			devDispatched: true,
			note: "Developer failed to resolve conflicts. Manual intervention required.",
		};
	} catch (devErr: unknown) {
		const msg = devErr instanceof Error ? devErr.message : String(devErr);
		log.error("pipeline-merge", `Failed to dispatch developer: ${msg}`);
		ctx.ui.notify(`Failed to dispatch developer: ${msg}`, "error");
		return { ok: false, devDispatched: true, note: `Failed to dispatch developer: ${msg}` };
	}
}
