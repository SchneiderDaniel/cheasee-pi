// ─── Pipeline Merge ──────────────────────────────────────────────
// Post-pipeline merge conflict orchestration.
// Extracted from pipeline.ts to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PrConflictInfo, SupervisorConfig } from "../config/types.ts";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { generateBranchName } from "../agent/task.ts";
import { tryAutoMerge } from "../config/merge.ts";
import { checkPrConflicts } from "../github/pr.ts";
import { parseAgentFile } from "../agent/loader.ts";
import { runAgent } from "../agent/runner.ts";
import { resolveTimeoutMs } from "../config/config.ts";
import { convertAgentRunToToolResult } from "../session/result.ts";
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
			conflictInfo = await checkPrConflicts(pi, branch, config.repo);
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

					const devAgentPath = `.pi/extensions/supervisor/agents/developer.md`;
					if (existsSync(devAgentPath)) {
						try {
							const devAgent = parseAgentFile(devAgentPath);
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

							log.info("pipeline-merge", "Dispatching developer for conflict resolution");
							const devTimeoutMs = resolveTimeoutMs("developer", config.agentTimeoutsMin);
							const devResult = await runAgent(devAgent, devTask, ctx, pi, devTimeoutMs);

							log.info(
								"pipeline-merge",
								`Developer conflict resolution: success=${devResult.success}`,
							);

							const subagentResult = convertAgentRunToToolResult(devResult, devTask);

							pi.sendMessage({
								customType: "supervisor",
								content: `## Conflict Resolution: ${devResult.agentName} — ${devResult.success ? "SUCCESS" : "FAILED"}\n\n${devResult.output || devResult.textOutput || devResult.summaryLine}`,
								display: true,
								details: {
									_subagentResult: subagentResult,
								},
							});

							if (devResult.success) {
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
					} else {
						log.warn("pipeline-merge", "Developer agent not found");
						ctx.ui.notify(
							"Developer agent not found. Cannot resolve conflicts automatically.",
							"error",
						);
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
	}
}
