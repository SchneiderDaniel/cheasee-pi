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
import { writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { generateBranchName } from "../agent/task.ts";
import type { GitHubPort } from "../github/ports.ts";
import { buildPipelineSummary } from "../pipeline/output.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";

/**
 * Maximum number of retry attempts for PR creation.
 * Handles transient GitHub API failures and rate limiting.
 */
const MAX_PR_CREATE_RETRIES = 2;

/** Base delay (ms) for exponential backoff retry. */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Create a pull request after auditor approves and transitions to Done.
 * Pushes branch, builds body, creates PR. Returns structured result so
 * the handler can detect failure and adjust pipeline completion status.
 */
export async function createPrOnApproval(
	port: GitHubPort,
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
	const tempFile = joinPath(tmpdir(), `pr-body-${issueNum}.md`);
	log.info("pr-creation", `Writing PR body to ${tempFile}`);

	// ─── Phase 1: Write body file ───────────────────────────────────
	try {
		await writeFile(tempFile, prBody, "utf-8");
	} catch (writeErr: unknown) {
		const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
		log.error("pr-creation", `Failed to write PR body file: ${writeMsg}`);
		ctx.ui.notify(`Failed to write PR body: ${writeMsg}`, "error");
		return {
			success: false,
			error: `Failed to write PR body file: ${writeMsg}`,
			source: "pr-creation",
		};
	}

	const prTitle = `feat(#${issueNum}): ${issueTitle}`;
	log.info("pr-creation", `PR title: ${prTitle}`);

	// ─── Phase 2: Push branch (if worktree exists) with retry ───────
	const MAX_PUSH_RETRIES = 3;
	const PUSH_RETRY_DELAYS_MS = [3000, 5000, 10000];
	if (worktreePath) {
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
				await pi.exec("git", ["push", "--force", config.remote!, headBranch], {
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
	}

	// ─── Phase 3: Pre-check — verify head has commits beyond base ──
	if (worktreePath) {
		try {
			const aheadCount = await port.compareBranches(
				config.defaultBranch!,
				headBranch,
				config.repo,
			);
			if (aheadCount === 0) {
				log.warn(
					"pr-creation",
					`No commits between ${config.defaultBranch} and ${headBranch} — skipping PR`,
				);
				ctx.ui.notify("Already implemented on base branch — no PR needed", "info");
				return {
					success: false,
					error: "Already implemented on base branch — no new changes to PR",
					source: "pr-creation",
				};
			}
			log.info("pr-creation", `Head is ${aheadCount} commits ahead of ${config.defaultBranch}`);
		} catch (compareErr: unknown) {
			const compareMsg = compareErr instanceof Error ? compareErr.message : String(compareErr);
			log.warn("pr-creation", `Commit count check failed: ${compareMsg} — attempting PR anyway`);
		}
	}

	// ─── Phase 4: Check for existing PR ────────────────────────────
	let existingPr: PrConflictInfo | null = null;
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

	// ─── Phase 5: Create or update PR (with retry) ─────────────────
	if (existingPr) {
		log.info("pr-creation", `PR #${existingPr.number} already exists — updating body`);
		try {
			ctx.ui.notify(`Updating PR #${existingPr.number} with latest changes`, "info");
			await port.updatePullRequest(existingPr.number, config.repo, prBody, prTitle);
			ctx.ui.notify(`PR #${existingPr.number} updated`, "info");
			return { success: true, prNumber: existingPr.number, wasUpdate: true, source: "pr-creation" };
		} catch (editErr: unknown) {
			const editMsg = editErr instanceof Error ? editErr.message : String(editErr);
			log.error("pr-creation", `Failed to update PR #${existingPr.number}: ${editMsg}`);
			ctx.ui.notify(`Failed to update PR #${existingPr.number}: ${editMsg}`, "error");
			return { success: false, error: `Failed to update PR: ${editMsg}`, source: "pr-creation" };
		}
	}

	// Create PR with retry
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
