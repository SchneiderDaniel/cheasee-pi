// ─── Pipeline Merge: pre-Done PR readiness gate ───────────────────
// The "before Done" actor: poll the PR for the worktree branch and drive the
// pr-gate round handlers until it is mergeable. Post-Done conflict
// orchestration lives in `merge-post.ts`; `merge.ts` is the barrel.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	PrConflictInfo,
	PrCreationResult,
	PipelineAgentResult,
	SupervisorConfig,
	AgentRunner,
} from "../config/types.ts";
import { generateBranchName } from "../lib/branch-name.ts";
import type { GitHubPort } from "../github/ports.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
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
				log.warn(
					"pipeline-merge",
					`PR readiness check failed: ${msg} — proceeding without blocking`,
					{
						branch,
					},
				);
				// Non-blocking: the post-Done backstop still catches stragglers.
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
					"Mergeability poll exhausted — proceeding without blocking (post-Done backstop covers)",
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
