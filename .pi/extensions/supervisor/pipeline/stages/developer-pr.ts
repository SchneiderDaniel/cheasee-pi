// ─── Pipeline Stages — developer PR upsert ───────────────────────
// Right after the developer's commit is pushed, make sure a PR exists for
// the branch: pre-audit CI gates need something to evaluate. Fail-soft —
// a GitHub hiccup must not gate the pipeline for a reason unrelated to the
// code; `ensurePrReadyForDone` stays the hard authority at approval.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	PipelineAgentResult,
	PrCreationResult,
	SupervisorConfig,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { type NotifyFn, nullNotify } from "../helpers.ts";
import { buildPrBody, upsertPullRequest } from "../pr-creation.ts";
import { hasBranchCommits } from "./git-ops.ts";

export interface UpsertDeveloperPrDeps {
	pi: ExtensionAPI;
	issueNum: number;
	issueTitle: string;
	config: SupervisorConfig;
	worktreePath: string;
	worktreeBranch: string | undefined;
	agentResults?: PipelineAgentResult[];
	port?: GitHubPort;
	notify?: NotifyFn;
	collector?: ErrorCollector;
}

/**
 * Create or update the developer's PR after the commit push. Never throws
 * and never stops the pipeline: failures are notified and collected.
 */
export async function upsertDeveloperPr(deps: UpsertDeveloperPrDeps): Promise<PrCreationResult> {
	const { pi, issueNum, issueTitle, config, worktreePath, worktreeBranch, port } = deps;
	const notify = deps.notify ?? nullNotify();
	const source = "developer-pr";

	try {
		if (!worktreeBranch) {
			return { success: false, error: "No worktree branch — skipping PR upsert", source };
		}
		// No port → no PR is possible; skip the git pre-check too.
		if (!port) {
			return { success: false, error: "GitHubPort not available — skipping PR upsert", source };
		}
		const hasCommits = await hasBranchCommits(
			pi.exec.bind(pi),
			worktreePath,
			worktreeBranch,
			config.defaultBranch!,
		);
		if (!hasCommits) {
			notify.info(`No commits on ${worktreeBranch} — skipping PR upsert`);
			return { success: false, error: `No commits on ${worktreeBranch}`, source };
		}

		const { title, body } = buildPrBody(issueNum, issueTitle, deps.agentResults ?? [], config, {
			overallStatus: "in-progress",
		});
		const result = await upsertPullRequest({
			repo: config.repo,
			base: config.defaultBranch!,
			head: worktreeBranch,
			title,
			body,
			port,
			notify: (message, level) => (level === "info" ? notify.info(message) : notify.error(message)),
		});
		if (!result.success) {
			deps.collector?.push(source, "error", `PR upsert failed: ${result.error ?? "unknown"}`);
		}
		return result;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`PR creation failed: ${msg}`);
		deps.collector?.push(source, "error", `PR creation failed: ${msg}`);
		return { success: false, error: msg, source };
	}
}
