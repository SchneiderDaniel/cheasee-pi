// ─── PR Creation ─────────────────────────────────────────────────
// PR creation logic: decoupled from handler, triggered on auditor approval.
// Returns structured result so the handler can react to failure.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	PrConflictInfo,
	PrCreationResult,
} from "../config/types.ts";

import { generateBranchName } from "../lib/branch-name.ts";
import type { GitHubPort } from "../github/ports.ts";
import {
	updatePullRequestBody as sharedUpdatePullRequestBody,
	upsertPullRequest as sharedUpsertPullRequest,
} from "../../shared/github/pull-request.ts";
import { tryRebaseOntoBase } from "./rebase.ts";
import { buildPrBody } from "../pipeline/output.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import type { PrBodyInput } from "./output.ts";

/** Body contract lives with the body renderer (output.ts); re-exported here. */
export type { PrBodyInput } from "./output.ts";

/**
 * Maximum number of retry attempts for gh pr create.
 * Handles transient GitHub API failures and rate limiting.
 */
const MAX_PR_CREATE_RETRIES = 2;

/** Base delay (ms) for exponential backoff retry. */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Verdict returned by verifyAhead helper.
 * - "ahead": head branch has commits beyond base — proceed with push
 * - "not-ahead": head is up-to-date or behind base — skip push
 * - "fail-closed": local fallback also failed — skip push with reason
 */
type AheadVerdict =
	{ state: "ahead" } | { state: "not-ahead" } | { state: "fail-closed"; reason: string };

/**
 * Verify that headBranch has commits ahead of defaultBranch.
 * Uses port.compareBranches as primary check, with a local git
 * fetch + merge-base --is-ancestor fallback if the port call fails.
 *
 * Does NOT own UX — returns a verdict for the caller to act on.
 */
async function verifyAhead(
	pi: ExtensionAPI,
	port: GitHubPort,
	config: SupervisorConfig,
	headBranch: string,
	worktreePath: string,
	log: ReturnType<typeof getDebugLogger>,
): Promise<AheadVerdict> {
	try {
		const aheadCount = await port.compareBranches(config.defaultBranch!, headBranch, config.repo);
		if (aheadCount === 0) {
			log.warn(
				"pr-creation",
				`No commits between ${config.defaultBranch} and ${headBranch} — skipping push and PR`,
			);
			return { state: "not-ahead" };
		}
		log.info("pr-creation", `Head is ${aheadCount} commits ahead of ${config.defaultBranch}`);
		return { state: "ahead" };
	} catch (compareErr: unknown) {
		const compareMsg = compareErr instanceof Error ? compareErr.message : String(compareErr);
		log.warn("pr-creation", `compareBranches failed: ${compareMsg} — using local fallback`);
		try {
			await pi.exec("git", ["fetch", config.remote!, headBranch], {
				cwd: worktreePath,
				timeout: 30000,
			});
			const mergeBase = await pi.exec(
				"git",
				["merge-base", "--is-ancestor", config.defaultBranch!, headBranch],
				{ cwd: worktreePath, timeout: 15000 },
			);
			// merge-base --is-ancestor exits 0 if defaultBranch is ancestor of headBranch
			if (mergeBase.code !== 0) {
				log.warn(
					"pr-creation",
					`Local check: ${headBranch} is not ahead of ${config.defaultBranch} — skipping PR`,
				);
				return { state: "not-ahead" };
			}
			log.info("pr-creation", "Local check passed — head is ahead of base");
			return { state: "ahead" };
		} catch (fallbackErr: unknown) {
			const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
			log.error(
				"pr-creation",
				`Local ahead check failed: ${fallbackMsg} — skipping push (fail-closed)`,
			);
			return { state: "fail-closed", reason: fallbackMsg };
		}
	}
}

/** Level-carrying notify hook handed to upsertPullRequest by its callers. */
export type PrNotify = (message: string, level: "info" | "warning" | "error") => void;

/** Body text has one owner (output.ts, issue #1831); re-exported here. */
export { buildPrBody };

/**
 * Idempotent create-or-update of the PR for one branch: list → update, else
 * create with retries. Callable both right after the developer's push (early
 * upsert, so pre-audit CI has a PR to evaluate) and at approval.
 *
 * The create-or-update sequence lives in `shared/github/pull-request.ts`
 * (issue #2138) so the goal-loop extension publishes PRs identically. This
 * wrapper only injects the Supervisor's debug logger.
 */
export async function upsertPullRequest(input: {
	repo: string;
	base: string;
	head: string;
	title: string;
	body: string;
	port?: GitHubPort;
	notify?: PrNotify;
}): Promise<PrCreationResult> {
	return await sharedUpsertPullRequest({ ...input, log: getDebugLogger() });
}

/**
 * Write a body onto an already-published PR — update-only, so a body refresh
 * can never open a second PR. The PR comes from `prNumber`, else the head
 * branch; no PR is a failure result, never a create (issue #1831).
 */
export async function publishPrBody(input: {
	repo: string;
	head: string;
	issueNum: number;
	issueTitle: string;
	agentResults: PipelineAgentResult[];
	config: SupervisorConfig | undefined;
	body: PrBodyInput;
	port?: GitHubPort;
	prNumber?: number;
	notify?: PrNotify;
}): Promise<PrCreationResult> {
	const { repo, head, port, notify } = input;
	if (!port) {
		notify?.("GitHubPort not available for PR body refresh", "error");
		return {
			success: false,
			error: "GitHubPort not available for PR body refresh",
			source: "pr-creation",
		};
	}
	const { title, body } = buildPrBody(
		input.issueNum,
		input.issueTitle,
		input.agentResults,
		input.config,
		input.body,
	);
	// Update-only path, shared with the goal-loop extension (issue #2138).
	return await sharedUpdatePullRequestBody({
		repo,
		head,
		title,
		body,
		prNumber: input.prNumber,
		port,
		notify,
		log: getDebugLogger(),
	});
}

/**
 * Create a pull request after auditor approves and transitions to Done.
 * Pushes branch, builds body, creates PR. Returns structured result so
 * the handler can detect failure and adjust pipeline completion status.
 *
 * Features:
 * - Returns PrCreationResult instead of void (Bug 6 fix)
 * - Push failure stops the flow early (Bug 3 fix)
 * - Retries gh pr create with exponential backoff (Bug 5 fix)
 * - Pre-checks commit count before PR creation (Bug 3 fix)
 * - Accepts a PrBodyInput for PR body gate failures, package safety and the
 *   auditor verdict (issue #1831 — one body input, no positional drift)
 */
export async function createPrOnApproval(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentResults: PipelineAgentResult[],
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	collector?: ErrorCollector,
	prBodyInput?: PrBodyInput,
	port?: GitHubPort,
): Promise<PrCreationResult> {
	const log = getDebugLogger();
	const headBranch =
		worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	const { title: prTitle, body: prBody } = buildPrBody(
		issueNum,
		issueTitle,
		agentResults,
		config,
		prBodyInput ?? { overallStatus: "success" },
	);

	log.info("pr-creation", `PR body built (${prBody.length} chars)`);
	log.info("pr-creation", `PR title: ${prTitle}`);

	// ─── Phase 2: Pre-check — verify head has commits beyond base ──
	// Runs BEFORE push so an up-to-date remote branch is never force-pushed;
	// when compareBranches fails, verifyAhead falls back to a local
	// fetch + merge-base --is-ancestor check.
	let skipPush = false;
	if (worktreePath && port) {
		const verdict = await verifyAhead(pi, port, config, headBranch, worktreePath, log);
		if (verdict.state === "not-ahead") {
			ctx.ui.notify("Already implemented on base branch — no PR needed", "info");
			return {
				success: false,
				error: "Already implemented on base branch — no new changes to PR",
				source: "pr-creation",
				pushSkipped: true,
			};
		}
		if (verdict.state === "fail-closed") {
			ctx.ui.notify(`Cannot verify branch state — skipping push: ${verdict.reason}`, "error");
			return {
				success: false,
				error: `Cannot verify branch state: ${verdict.reason}`,
				source: "pr-creation",
				pushSkipped: true,
			};
		}
		// verdict.state === "ahead" — proceed
	} else if (worktreePath) {
		log.warn("pr-creation", "Port not available — cannot verify ahead count, proceeding with push");
	}

	// ─── Phase 2.5: Rebase onto latest base branch ─────────────────
	// A stale base conflicts with PRs merged mid-run, so rebase first; a
	// conflict returns rebaseConflicts for the post-PR merge handler
	// (handlePostPipelineMerge) to dispatch a developer agent.
	if (worktreePath && !skipPush) {
		log.info("pr-creation", `Rebasing onto ${config.remote}/${config.defaultBranch}`);
		const rebaseResult = await tryRebaseOntoBase(
			worktreePath,
			config.defaultBranch!,
			config.remote!,
			pi,
		);

		if (!rebaseResult.success) {
			if (rebaseResult.conflictFiles.length > 0) {
				log.warn(
					"pr-creation",
					`Rebase conflicts in ${rebaseResult.conflictFiles.length} files: ${rebaseResult.conflictFiles.join(", ")}`,
				);
				ctx.ui.notify(
					`Rebase conflicts with latest ${config.defaultBranch} in ${rebaseResult.conflictFiles.length} file(s): ${rebaseResult.conflictFiles.join(", ")}. Post-PR merge handler will dispatch developer for resolution.`,
					"warning",
				);
				return {
					success: false,
					error: rebaseResult.message,
					source: "pr-creation",
					pushSkipped: true,
					rebaseConflicts: rebaseResult.conflictFiles,
				};
			}
			// Non-conflict failure (fetch failed, etc.)
			log.error("pr-creation", `Rebase failed: ${rebaseResult.message}`);
			ctx.ui.notify(
				`Cannot rebase onto latest ${config.defaultBranch}: ${rebaseResult.message}`,
				"error",
			);
			return {
				success: false,
				error: rebaseResult.message,
				source: "pr-creation",
				pushSkipped: true,
			};
		}
		log.info("pr-creation", "Rebase succeeded — proceeding with push");
	} else if (!worktreePath) {
		log.info("pr-creation", "No worktree path — skipping rebase");
	} else {
		log.info("pr-creation", "Skip push is set — skipping rebase");
	}

	// ─── Phase 3: Push branch (if worktree exists) with retry ───────
	// Timeout: 60s per attempt. Retry with exponential backoff (3 attempts).
	// Uses --force-with-lease to avoid overwriting remote commits we haven't seen.
	const MAX_PUSH_RETRIES = 3;
	const PUSH_RETRY_DELAYS_MS = [3000, 5000, 10000];
	if (worktreePath && !skipPush) {
		log.info("pr-creation", `Pushing ${headBranch} from worktree`);
		let lastPushErr: unknown;
		let pushSucceeded = false;
		for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
			try {
				if (attempt > 0) {
					const delayMs = PUSH_RETRY_DELAYS_MS[attempt - 1] ?? 5000;
					log.info(
						"pr-creation",
						`Push retry ${attempt + 1}/${MAX_PUSH_RETRIES} after ${delayMs}ms`,
					);
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					// --force-with-lease checks the LOCAL remote-tracking ref: a stale
					// lease (branch deleted with the PR, or a pre-push fetch moved it)
					// fails identically every attempt, so refresh it before retrying.
					const pruneResult = await pi.exec("git", ["fetch", "--prune", config.remote!], {
						cwd: worktreePath,
						timeout: 30000,
					});
					if (pruneResult.code !== 0 || pruneResult.killed) {
						throw new Error(
							`git fetch --prune ${config.remote} failed: ${
								pruneResult.stderr || pruneResult.stdout || `exit ${pruneResult.code}`
							}`.trim(),
						);
					}
				}
				// pi.exec always RESOLVES {code, stdout, stderr, killed} — it never
				// rejects on non-zero exit. Inspect the result explicitly: a failed
				// push (rejected refs, transport/auth, timeout kill) must fail the
				// attempt, or the pipeline reports success against a remote branch
				// that was never updated.
				const pushResult = await pi.exec(
					"git",
					["push", "--force-with-lease", config.remote!, headBranch],
					{ cwd: worktreePath, timeout: 60000 },
				);
				if (pushResult.code !== 0 || pushResult.killed) {
					throw new Error(
						(
							pushResult.stderr ||
							pushResult.stdout ||
							(pushResult.killed
								? "git push timed out and was killed"
								: `git push failed (exit ${pushResult.code})`)
						).trim(),
					);
				}
				log.info("pr-creation", "Push OK");
				pushSucceeded = true;
				break;
			} catch (pushErr: unknown) {
				lastPushErr = pushErr;
				const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
				log.warn(
					"pr-creation",
					`Push attempt ${attempt + 1}/${MAX_PUSH_RETRIES} failed: ${pushMsg}`,
				);
			}
		}
		if (!pushSucceeded) {
			const pushMsg = lastPushErr instanceof Error ? lastPushErr.message : String(lastPushErr);
			log.error("pr-creation", `All ${MAX_PUSH_RETRIES} push attempts failed: ${pushMsg}`);
			ctx.ui.notify(`Branch push failed after ${MAX_PUSH_RETRIES} attempts: ${pushMsg}`, "error");
			return {
				success: false,
				error: `Branch push failed after ${MAX_PUSH_RETRIES} attempts: ${pushMsg}`,
				source: "pr-creation",
			};
		}
	} else if (!worktreePath) {
		log.info("pr-creation", "No worktree path — skipping push");
	}

	// ─── Phase 4+5: Create or update PR (idempotent) ───────────────
	// Ahead-check, rebase and push above stay here — the approval path owns
	// publishing. Only the PR lifecycle is shared with the early upsert.
	return await upsertPullRequest({
		repo: config.repo,
		base: config.defaultBranch!,
		head: headBranch,
		title: prTitle,
		body: prBody,
		port,
		notify: (message, level) => ctx.ui.notify(message, level),
	});
}
