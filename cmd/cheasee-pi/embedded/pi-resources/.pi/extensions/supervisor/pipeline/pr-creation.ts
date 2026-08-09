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

import { generateBranchName } from "../agent/task.ts";
import type { GitHubPort } from "../github/ports.ts";
import { tryRebaseOntoBase } from "./rebase.ts";
import { buildPipelineSummary } from "../pipeline/output.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";

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
	| { state: "ahead" }
	| { state: "not-ahead" }
	| { state: "fail-closed"; reason: string };

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
			log.warn("pr-creation", `No commits between ${config.defaultBranch} and ${headBranch} — skipping push and PR`);
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
				log.warn("pr-creation", `Local check: ${headBranch} is not ahead of ${config.defaultBranch} — skipping PR`);
				return { state: "not-ahead" };
			}
			log.info("pr-creation", "Local check passed — head is ahead of base");
			return { state: "ahead" };
		} catch (fallbackErr: unknown) {
			const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
			log.error("pr-creation", `Local ahead check failed: ${fallbackMsg} — skipping push (fail-closed)`);
			return { state: "fail-closed", reason: fallbackMsg };
		}
	}
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
 * - Accepts gateFailureHistory for PR body gate failure context (R2)
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
	gateFailureHistory?: string[],
	packageSafetyResult?: PackageSafetyAuditResult | null,
	port?: GitHubPort,
): Promise<PrCreationResult> {
	const log = getDebugLogger();
	const headBranch =
		worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	const prBody = buildPipelineSummary(
		agentResults,
		"success",
		issueNum,
		issueTitle,
		config,
		undefined,
		undefined,
		gateFailureHistory,
		packageSafetyResult,
	);

	log.info("pr-creation", `PR body built (${prBody.length} chars)`);

	const prTitle = `feat(#${issueNum}): ${issueTitle}`;
	log.info("pr-creation", `PR title: ${prTitle}`);

	// ─── Phase 2: Pre-check — verify head has commits beyond base ──
	// Runs BEFORE push to avoid force-pushing over existing remote commits.
	// When the remote branch already has commits ahead of main, the push is
	// skipped entirely (the branch is already up-to-date on the remote).
	//
	// Fallback: if port.compareBranches fails (network error), use local git
	// fetch + merge-base --is-ancestor to determine whether to push.
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
	// Fetch latest defaultBranch and rebase worktree branch onto it
	// to avoid stale-base merge conflicts caused by PRs merged during
	// pipeline runtime. On conflict, return early with rebaseConflicts
	// so the post-PR merge handler (handlePostPipelineMerge) can dispatch
	// the developer agent for resolution.
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
				}
				await pi.exec("git", ["push", "--force-with-lease", config.remote!, headBranch], {
					cwd: worktreePath,
					timeout: 60000,
				});
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

	// ─── Phase 4: Check for existing PR ────────────────────────────
	let existingPr: PrConflictInfo | null = null;
	if (port) {
		try {
			existingPr = await port.listPullRequestsForBranch(headBranch, config.repo);
		} catch (checkErr: unknown) {
			const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
			log.warn("pr-creation", `PR conflict check failed: ${checkMsg}`);
			ctx.ui.notify(
				`PR conflict check failed: ${checkMsg} — attempting PR creation anyway`,
				"warning",
			);
		}
	} else {
		log.warn("pr-creation", "Port not available — skipping PR check");
	}

	// ─── Phase 5: Create or update PR (with retry) ─────────────────
	if (existingPr) {
		log.info("pr-creation", `PR #${existingPr.number} already exists — updating body`);
		try {
			ctx.ui.notify(`Updating PR #${existingPr.number} with latest changes`, "info");
			if (port) {
				await port.updatePullRequest(existingPr.number, config.repo, prBody, prTitle);
			}
			ctx.ui.notify(`PR #${existingPr.number} updated`, "info");
			return { success: true, prNumber: existingPr.number, wasUpdate: true, source: "pr-creation" };
		} catch (editErr: unknown) {
			const editMsg = editErr instanceof Error ? editErr.message : String(editErr);
			log.error("pr-creation", `Failed to update PR #${existingPr.number}: ${editMsg}`);
			ctx.ui.notify(`Failed to update PR #${existingPr.number}: ${editMsg}`, "error");
			return { success: false, error: `Failed to update PR: ${editMsg}`, source: "pr-creation" };
		}
	}

	// Create PR with retry (Bug 5 fix)
	let lastError: string | undefined;
	for (let attempt = 0; attempt < MAX_PR_CREATE_RETRIES; attempt++) {
		try {
			if (attempt > 0) {
				const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
				log.info(
					"pr-creation",
					`Retry attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} after ${delayMs}ms`,
				);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}

			if (!port) throw new Error("GitHubPort not available for PR creation");
			const prResult = await port.createPullRequest({
				repo: config.repo,
				base: config.defaultBranch!,
				head: headBranch,
				title: prTitle,
				body: prBody,
			});
			log.info("pr-creation", `PR #${prResult.number} created`);
			ctx.ui.notify(`PR #${prResult.number} created`, "info");
			return { success: true, prNumber: prResult.number, source: "pr-creation" };
		} catch (prErr: unknown) {
			lastError = prErr instanceof Error ? prErr.message : String(prErr);
			log.warn(
				"pr-creation",
				`Attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} failed: ${lastError}`,
			);
		}
	}

	// All retries exhausted
	const errorMsg = lastError || "Unknown error during PR creation";
	log.error("pr-creation", `All ${MAX_PR_CREATE_RETRIES} attempts failed: ${errorMsg}`);
	ctx.ui.notify(
		`Failed to create PR after ${MAX_PR_CREATE_RETRIES} attempts: ${errorMsg}`,
		"error",
	);
	return { success: false, error: errorMsg, source: "pr-creation" };
}
