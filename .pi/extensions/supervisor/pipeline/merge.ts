// ─── Pipeline Merge ──────────────────────────────────────────────
// Pre-Done PR readiness gate + post-pipeline merge conflict
// orchestration (issue #2005 split: the gate round handlers live in
// pr-gate.ts, the shared conflict resolution in merge-conflicts.ts).
// Re-exports the extracted names so existing importers of merge.ts
// keep working.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	PrConflictInfo,
	PrCreationResult,
	PipelineAgentResult,
	SupervisorConfig,
	AgentRunner,
} from "../config/types.ts";
import { generateBranchName } from "../agent/task.ts";
import type { GitHubPort } from "../github/ports.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import { resolveBranchConflicts } from "./merge-conflicts.ts";
import {
	awaitPrMergeability,
	classifyMergeability,
	handleMissingPr,
	handleSettledPrState,
	type PrGateDeps,
	type PrGateVerdict,
	type RoundState,
} from "./pr-gate.ts";

export async function ensurePrReadyForDone(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentResults: PipelineAgentResult[],
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	prCreationResult: PrCreationResult | undefined,
	collector?: ErrorCollector,
	port?: GitHubPort,
	runner?: AgentRunner,
	polls?: { attempts: number; backoffMs: number[] },
): Promise<PrGateVerdict> {
	const log = getDebugLogger();
	const branch = worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);
	const mergePoll = polls ?? { attempts: 5, backoffMs: [2000, 4000, 8000, 16000, 32000] };
	const state: RoundState = { current: prCreationResult, retried: false };

	try {
		ctx.ui.setStatus("supervisor", "Verifying PR readiness before Done...");

		if (!port) {
			return {
				ok: false,
				prCreationResult: state.current,
				blockerNote: "GitHubPort not available — cannot verify PR readiness.",
			};
		}
		const deps: PrGateDeps = {
			pi,
			ctx,
			issueNum,
			issueTitle,
			config,
			agentResults,
			worktreePath,
			worktreeBranch,
			collector,
			runner,
			port,
		};

		for (let round = 0; round < 3; round++) {
			let info: PrConflictInfo | null;
			try {
				info = await port.listPullRequestsForBranch(branch, config.repo);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn("pipeline-merge", `PR readiness check failed: ${msg} — proceeding fail-open`, {
					branch,
				});
				// Fail-open: the post-Done backstop still catches stragglers.
				return { ok: true, prCreationResult: state.current };
			}

			const klass = classifyMergeability(info, state.current);
			if (klass.kind === "no-pr") {
				const outcome = await handleMissingPr(deps, state, branch, mergePoll, klass.mode);
				if ("verdict" in outcome) return outcome.verdict;
				continue;
			}

			// PR exists (or mergeability still computing) — poll until settled.
			// Non-no-pr kinds guarantee info is present.
			const settled = await awaitPrMergeability(port, branch, config.repo, mergePoll);
			if (!settled) {
				log.warn(
					"pipeline-merge",
					"Mergeability poll exhausted — proceeding fail-open (post-Done backstop covers)",
					{ prNumber: info!.number },
				);
				return { ok: true, prCreationResult: state.current };
			}
			const outcome = await handleSettledPrState(deps, state, branch, settled);
			if ("verdict" in outcome) return outcome.verdict;
		}

		return {
			ok: false,
			prCreationResult: state.current,
			blockerNote: "PR readiness verification did not settle — manual intervention required.",
		};
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
		// Clear developer widget in case it wasn't cleaned up
		ctx.ui.setWidget("agent-developer", undefined);
	}
}

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

export {
	awaitPrMergeability,
	classifyMergeability,
	type MergeabilityClass,
	type PrGateVerdict,
} from "./pr-gate.ts";

