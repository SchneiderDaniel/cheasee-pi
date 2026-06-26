// ─── Pipeline Merge ──────────────────────────────────────────────
// Post-pipeline merge conflict orchestration.
// Extracted from pipeline.ts to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PrConflictInfo, SupervisorConfig } from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { generateBranchName } from "../agent/task.ts";
import { tryAutoMerge } from "../config/merge.ts";
import { checkPrConflicts } from "../github/pr.ts";
import { runAgentSubprocess, DEFAULT_AGENT_TIMEOUT_MS } from "../agent/runner.ts";
import { parseAgentFile } from "../agent/loader.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";

/**
 * Handle post-pipeline merge conflict detection and resolution.
 * Called when pipeline reaches "Done" status.
 */
export async function handlePostPipelineMerge(
	issueNum: number,
	issueTitle: string,
	loopStatus: string,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath?: string,
	collector?: ErrorCollector,
	// ponytail: test hook for injecting mock runner; external callers omit this
	_runner?: typeof runAgentSubprocess,
): Promise<void> {
	const log = getDebugLogger();
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	log.info("pipeline-merge", `Post-pipeline merge check for #${issueNum}`, {
		branch,
		repo: config.repo,
		loopStatus,
	});

	try {
		ctx.ui.setStatus("supervisor", "Checking PR for merge conflicts...");
		let conflictInfo: PrConflictInfo | null;
		try {
			conflictInfo = await checkPrConflicts(pi.exec.bind(pi), branch, config.repo);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`PR conflict check failed: ${msg}`, "error");
			collector?.push("merge", "error", `PR conflict check failed: ${msg}`);
			return;
		}

		if (!conflictInfo) {
			log.info("pipeline-merge", "No PR found for branch — skipping");
			ctx.ui.notify("No PR found for this branch — skipping conflict check.", "info");
			return;
		}

		if (conflictInfo.hasConflict) {
			log.warn("pipeline-merge", `PR #${conflictInfo.number} has conflicts`, {
				mergeable: conflictInfo.mergeable,
				mergeStateStatus: conflictInfo.mergeStateStatus,
				baseRef: conflictInfo.baseRefName,
				headRef: conflictInfo.headRefName,
			});
			ctx.ui.notify(
				`PR #${conflictInfo.number} has merge conflicts! (mergeable: ${conflictInfo.mergeable}, state: ${conflictInfo.mergeStateStatus})`,
				"warning",
			);

			// Mode adaptation: when hasUI is false (print/json mode),
			// default to true (attempt auto-merge) without prompting.
			const shouldFix = ctx.hasUI
				? await ctx.ui.confirm(
						"Merge Conflict Detected",
						`PR #${conflictInfo.number} (${branch}) has merge conflicts with ${conflictInfo.baseRefName}. Should I fix them?`,
					)
				: true;

			if (shouldFix) {
				const wt =
					worktreePath ?? resolvePath(ctx.cwd || process.cwd(), config.worktreeBase!, branch);

				ctx.ui.setStatus("supervisor", "Attempting auto-merge...");
				log.info("pipeline-merge", "Attempting auto-merge", { wt, branch });
				const mergeResult = await tryAutoMerge(
					wt,
					branch,
					config.defaultBranch!,
					config.remote!,
					pi,
				);
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
							content: `## ✅ Merge Conflicts Resolved\n\nPR #${conflictInfo.number} conflicts were resolved automatically and pushed.`,
							display: true,
						});
					} catch (pushErr: unknown) {
						const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
						log.error("pipeline-merge", `Merge succeeded but push failed: ${msg}`);
						ctx.ui.notify(`Merge succeeded but push failed: ${msg}`, "error");
						collector?.push("merge", "error", `Merge succeeded but push failed: ${msg}`);
					}
				} else {
					log.info("pipeline-merge", "Auto-merge failed, dispatching developer");
					ctx.ui.notify(
						`Auto-merge failed: ${mergeResult.message}. Dispatching developer to resolve...`,
						"warning",
					);

					const devTask = [
						`## Task: Resolve Merge Conflicts`,
						``,
						`**Branch:** ${branch}`,
						`**Worktree:** ${wt}`,
						`**Base branch:** ${config.defaultBranch}`,
						`**Conflicted files:** ${mergeResult.conflictFiles.join(", ") || "(unknown)"}`,
						``,
						`### Steps`,
						`1. Enter worktree: \`cd ${wt}\``,
						`2. Fetch base: \`git fetch ${config.remote} ${config.defaultBranch}\``,
						`3. Merge base: \`git merge ${config.remote}/${config.defaultBranch}\``,
						`4. Resolve conflicts in the conflicted files`,
						`5. Stage resolved files: \`git add -A\``,
						`6. Commit merge: \`git commit -m "fix: resolve merge conflicts for PR #${conflictInfo.number}"\``,
						`7. Push: \`git push ${config.remote} ${branch}\``,
						``,
						`When done, output CONFLICTS_RESOLVED on its own line.`,
					].join("\n");

					// Dispatch developer via subprocess for consistent widget rendering
					log.info("pipeline-merge", "Dispatching developer for conflict resolution");
					try {
						const agentPath = resolvePath(wt, ".pi/extensions/supervisor/agents/developer.md");
						const { existsSync } = await import("node:fs");
						if (!existsSync(agentPath)) {
							throw new Error(`Agent file not found: ${agentPath}`);
						}
						const developerAgent = parseAgentFile(agentPath);

						const devTimeoutMs = config.agentTimeoutsMin?.developer
							? config.agentTimeoutsMin.developer * 60 * 1000
							: DEFAULT_AGENT_TIMEOUT_MS;

						const devResult = await (_runner ?? runAgentSubprocess)(
							developerAgent,
							devTask,
							ctx,
							devTimeoutMs,
							wt,
							config.maxToolCalls,
							config.agentTokenBudget,
						);

						const devSuccess = devResult.success;

						log.info("pipeline-merge", `Developer conflict resolution: success=${devSuccess}`);

						pi.sendMessage({
							customType: "supervisor",
							content: `## Conflict Resolution: developer — ${devSuccess ? "SUCCESS" : "FAILED"}\n\n${devResult.summaryLine || ""}`,
							display: true,
							details: {
								eventType: "subagent-result",
								agentName: "developer",
								content: [{ type: "text", text: devResult.textOutput || "" }],
								details: {
									agentName: "developer",
									success: devSuccess,
									statusLabel: devSuccess ? "SUCCESS" : "FAILED",
									summaryLine: devResult.summaryLine || "",
								},
							},
						});

						if (devSuccess) {
							log.info("pipeline-merge", "Developer resolved conflicts");
							ctx.ui.notify("Developer resolved merge conflicts successfully!", "info");
						} else {
							log.warn("pipeline-merge", "Developer failed to resolve conflicts");
							ctx.ui.notify(
								"Developer failed to resolve conflicts. Manual intervention required.",
								"error",
							);
						}
					} catch (devErr: unknown) {
						const msg = devErr instanceof Error ? devErr.message : String(devErr);
						log.error("pipeline-merge", `Failed to dispatch developer: ${msg}`);
						ctx.ui.notify(`Failed to dispatch developer: ${msg}`, "error");
					}
				}
			}
		} else {
			log.info("pipeline-merge", `PR #${conflictInfo.number} has no conflicts`);
			ctx.ui.notify(
				`PR #${conflictInfo.number} has no merge conflicts (mergeable: ${conflictInfo.mergeable}).`,
				"info",
			);
		}
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
		// Clear developer widget in case it wasn't cleaned up
		ctx.ui.setWidget("agent-developer", undefined);
	}
}
