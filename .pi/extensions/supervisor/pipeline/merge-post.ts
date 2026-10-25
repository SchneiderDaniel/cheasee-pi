// ─── Pipeline Merge: post-Done conflict orchestration ─────────────
// The "after Done" actor: backstop for merge races that slip past the
// pre-Done gate in `merge-gate.ts`. `merge.ts` is the barrel.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PrConflictInfo, SupervisorConfig, AgentRunner } from "../config/types.ts";
import { generateBranchName } from "../lib/branch-name.ts";
import type { GitHubPort } from "../github/ports.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import { resolveBranchConflicts } from "./merge-conflicts.ts";

/**
 * Handle post-pipeline merge conflict detection and resolution.
 * Called after the pipeline reaches "Done" status — backstop for races
 * that slip past the pre-Done gate.
 *
 * When `rebaseConflicts` is set and no PR exists (#1455 mode: PR creation
 * failed on rebase), the "No PR found" early return is skipped and the
 * conflicts are resolved directly.
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
	_runner?: AgentRunner,
	port?: GitHubPort,
	rebaseConflicts?: string[],
): Promise<boolean> {
	const log = getDebugLogger();
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	log.info("pipeline-merge", `Post-pipeline merge check for #${issueNum}`, {
		branch,
		repo: config.repo,
		loopStatus,
	});

	let unresolvedConflicts = false;

	try {
		ctx.ui.setStatus("supervisor", "Checking PR for merge conflicts...");
		let conflictInfo: PrConflictInfo | null;
		try {
			if (!port) {
				ctx.ui.notify("GitHubPort not available — skipping conflict check", "error");
				return false;
			}
			conflictInfo = await port.listPullRequestsForBranch(branch, config.repo);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`PR conflict check failed: ${msg}`, "error");
			collector?.push("merge", "error", `PR conflict check failed: ${msg}`);
			return false;
		}

		const rebaseOnly = !conflictInfo && (rebaseConflicts?.length ?? 0) > 0;
		if (!conflictInfo && !rebaseOnly) {
			log.info("pipeline-merge", "No PR found for branch — skipping");
			ctx.ui.notify("No PR found for this branch — skipping conflict check.", "info");
			return false;
		}

		if (rebaseOnly) {
			// #1455 mode: PR creation failed with rebase conflicts, no PR exists.
			unresolvedConflicts = true;
			log.warn("pipeline-merge", "No PR found but rebase conflicts reported — resolving", {
				rebaseConflicts,
			});
			ctx.ui.notify(
				`PR creation failed with rebase conflicts in ${rebaseConflicts!.length} file(s) — attempting resolution.`,
				"warning",
			);
			const shouldFix = ctx.hasUI
				? await ctx.ui.confirm(
						"Merge Conflict Detected",
						`PR creation for ${branch} failed with rebase conflicts in ${rebaseConflicts!.join(", ")}. Should I fix them?`,
					)
				: true;
			if (shouldFix) {
				const resolved = await resolveBranchConflicts(
					issueNum,
					branch,
					undefined,
					config,
					pi,
					ctx,
					worktreePath,
					collector,
					_runner,
					rebaseConflicts,
				);
				if (resolved.ok) unresolvedConflicts = false;
			}
			return unresolvedConflicts;
		}

		if (conflictInfo!.hasConflict) {
			unresolvedConflicts = true;
			log.warn("pipeline-merge", `PR #${conflictInfo!.number} has conflicts`, {
				mergeable: conflictInfo!.mergeable,
				mergeStateStatus: conflictInfo!.mergeStateStatus,
				baseRef: conflictInfo!.baseRefName,
				headRef: conflictInfo!.headRefName,
			});
			ctx.ui.notify(
				`PR #${conflictInfo!.number} has merge conflicts! (mergeable: ${conflictInfo!.mergeable}, state: ${conflictInfo!.mergeStateStatus})`,
				"warning",
			);

			// Mode adaptation: when hasUI is false (print/json mode),
			// default to true (attempt auto-merge) without prompting.
			const shouldFix = ctx.hasUI
				? await ctx.ui.confirm(
						"Merge Conflict Detected",
						`PR #${conflictInfo!.number} (${branch}) has merge conflicts with ${conflictInfo!.baseRefName}. Should I fix them?`,
					)
				: true;

			if (shouldFix) {
				const resolved = await resolveBranchConflicts(
					issueNum,
					branch,
					conflictInfo!.number,
					config,
					pi,
					ctx,
					worktreePath,
					collector,
					_runner,
				);
				if (resolved.ok) unresolvedConflicts = false;
			}
		} else {
			log.info("pipeline-merge", `PR #${conflictInfo!.number} has no conflicts`);
			ctx.ui.notify(
				`PR #${conflictInfo!.number} has no merge conflicts (mergeable: ${conflictInfo!.mergeable}).`,
				"info",
			);
			unresolvedConflicts = false;
		}
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
		// Clear developer widget in case it wasn't cleaned up
		ctx.ui.setWidget("agent-developer", undefined);
	}
	return unresolvedConflicts;
}
