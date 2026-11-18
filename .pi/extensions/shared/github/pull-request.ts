// ─── Pull-request create-or-update (shared) ──────────────────────
// Extracted from supervisor/pipeline/pr-creation.ts (issue #2138) so the
// goal-loop extension publishes PRs with the identical idempotent sequence:
// list-by-branch → update body when a PR exists, else create with retries.
//
// The port is a structural subset of Supervisor's `GitHubPort`, so Supervisor
// passes its port unchanged; the goal-loop's GitHub adapter implements it
// directly. Logging and notification are injected, keeping this module free of
// either extension's concrete logger.
//
// `markReadyForReview` is deliberately NOT here: the REST API silently ignores
// `draft: false`, so un-drafting is GraphQL-only and belongs to the caller's
// adapter (see goal-loop/adapters/github-pull-request.ts).

import { failure, type Result } from "../result.ts";

/** The PR operations this module needs. Supervisor's GitHubPort satisfies it. */
export interface PrPortLike {
	listPullRequestsForBranch(branch: string, repo: string): Promise<{ number: number } | null>;
	createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }>;
	updatePullRequest(prNumber: number, repo: string, body: string, title?: string): Promise<void>;
}

/** Level-carrying notify hook (same shape Supervisor's pr-creation passes). */
export type PrNotify = (message: string, level: "info" | "warning" | "error") => void;

/** Minimal debug-logger port; Supervisor passes its DebugLogger unchanged. */
export interface PrLogger {
	info(context: string, message: string): void;
	warn(context: string, message: string): void;
	error(context: string, message: string): void;
}

/** Outcome of one create-or-update attempt. */
export interface PrUpsertResult {
	success: boolean;
	prNumber?: number;
	error?: string;
	wasUpdate?: boolean;
	source?: string;
}

/** Maximum number of create attempts (transient API failures, rate limits). */
const MAX_PR_CREATE_RETRIES = 2;

/** Base delay (ms) for exponential backoff retry. */
const RETRY_BASE_DELAY_MS = 1000;

const LOG_CONTEXT = "pr-creation";

export interface UpsertPullRequestInput {
	repo: string;
	base: string;
	head: string;
	title: string;
	body: string;
	port?: PrPortLike;
	notify?: PrNotify;
	log?: PrLogger;
	/** Injected so tests do not wait on the real backoff timer. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Update an existing PR, mapping failures to a PrUpsertResult.
 *
 * Module-local in spirit: `upsertPullRequest` and `updatePullRequestBody` are
 * the only ways in, so every PR write in this module goes through one
 * update path.
 */
async function updateExistingPr(
	input: UpsertPullRequestInput,
	prNumber: number,
): Promise<PrUpsertResult> {
	const { repo, title, body, port, notify, log } = input;
	try {
		notify?.(`Updating PR #${prNumber} with latest changes`, "info");
		await port!.updatePullRequest(prNumber, repo, body, title);
		notify?.(`PR #${prNumber} updated`, "info");
		return { success: true, prNumber, wasUpdate: true, source: LOG_CONTEXT };
	} catch (editErr: unknown) {
		const editMsg = editErr instanceof Error ? editErr.message : String(editErr);
		log?.error(LOG_CONTEXT, `Failed to update PR #${prNumber}: ${editMsg}`);
		notify?.(`Failed to update PR #${prNumber}: ${editMsg}`, "error");
		return { success: false, error: `Failed to update PR: ${editMsg}`, source: LOG_CONTEXT };
	}
}

/**
 * Idempotent create-or-update of the PR for one branch.
 *
 * Existing PR → update body (never a second PR). Otherwise create with one
 * retry; an "already exists" create error re-lists once and updates instead of
 * burning the retry budget.
 */
export async function upsertPullRequest(input: UpsertPullRequestInput): Promise<PrUpsertResult> {
	const { repo, base, head, title, body, port, notify, log } = input;
	const sleep = input.sleep ?? defaultSleep;

	if (!port) {
		log?.warn(LOG_CONTEXT, "Port not available — cannot create or update PR");
		notify?.("GitHubPort not available for PR creation", "error");
		return {
			success: false,
			error: "GitHubPort not available for PR creation",
			source: LOG_CONTEXT,
		};
	}

	// ─── Check for an existing PR ────────────────────────────────
	let existingPr: { number: number } | null = null;
	try {
		existingPr = await port.listPullRequestsForBranch(head, repo);
	} catch (checkErr: unknown) {
		const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
		log?.warn(LOG_CONTEXT, `PR conflict check failed: ${checkMsg}`);
		notify?.(`PR conflict check failed: ${checkMsg} — attempting PR creation anyway`, "warning");
	}

	if (existingPr) {
		log?.info(LOG_CONTEXT, `PR #${existingPr.number} already exists — updating body`);
		return await updateExistingPr(input, existingPr.number);
	}

	// ─── Create (with retry) ─────────────────────────────────────
	let lastError: string | undefined;
	for (let attempt = 0; attempt < MAX_PR_CREATE_RETRIES; attempt++) {
		try {
			if (attempt > 0) {
				const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
				log?.info(
					LOG_CONTEXT,
					`Retry attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} after ${delayMs}ms`,
				);
				await sleep(delayMs);
			}

			const prResult = await port.createPullRequest({ repo, base, head, title, body });
			log?.info(LOG_CONTEXT, `PR #${prResult.number} created`);
			notify?.(`PR #${prResult.number} created`, "info");
			return { success: true, prNumber: prResult.number, source: LOG_CONTEXT };
		} catch (prErr: unknown) {
			lastError = prErr instanceof Error ? prErr.message : String(prErr);
			log?.warn(
				LOG_CONTEXT,
				`Attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} failed: ${lastError}`,
			);

			// Race: a PR for this head appeared after our list call. Re-list once
			// and update instead of burning the retry budget on a create that can
			// never succeed.
			if (/already exists/i.test(lastError)) {
				let raced: { number: number } | null = null;
				try {
					raced = await port.listPullRequestsForBranch(head, repo);
				} catch (relErr: unknown) {
					log?.warn(
						LOG_CONTEXT,
						`Re-list after "already exists" failed: ${
							relErr instanceof Error ? relErr.message : String(relErr)
						}`,
					);
				}
				if (!raced) {
					log?.error(LOG_CONTEXT, `PR exists per create error but not on re-list: ${lastError}`);
					notify?.(`Failed to create PR: ${lastError}`, "error");
					return { success: false, error: lastError, source: LOG_CONTEXT };
				}
				log?.info(LOG_CONTEXT, `PR #${raced.number} appeared — updating instead of creating`);
				return await updateExistingPr(input, raced.number);
			}
		}
	}

	const errorMsg = lastError || "Unknown error during PR creation";
	log?.error(LOG_CONTEXT, `All ${MAX_PR_CREATE_RETRIES} attempts failed: ${errorMsg}`);
	notify?.(`Failed to create PR after ${MAX_PR_CREATE_RETRIES} attempts: ${errorMsg}`, "error");
	return { success: false, error: errorMsg, source: LOG_CONTEXT };
}

/**
 * Resolve the PR number for a head branch, or fail closed when there is none.
 * Used by callers that must not create (body refresh, ready-for-review).
 */
export async function findPullRequestNumber(
	port: PrPortLike,
	repo: string,
	head: string,
): Promise<Result<number>> {
	try {
		const found = await port.listPullRequestsForBranch(head, repo);
		if (!found) return failure(`No PR found for ${head}`, LOG_CONTEXT);
		return { ok: true, value: found.number };
	} catch (err: unknown) {
		return failure(
			`PR lookup failed: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT,
		);
	}
}

/**
 * Write a body onto an already-published PR — update-only, so a body refresh
 * can never open a second PR. `prNumber` wins; otherwise the head branch is
 * resolved and a missing PR is a failure result, never a create.
 */
export async function updatePullRequestBody(
	input: Omit<UpsertPullRequestInput, "base"> & { prNumber?: number },
): Promise<PrUpsertResult> {
	const { repo, head, port, log, notify } = input;
	if (!port) {
		notify?.("GitHubPort not available for PR body refresh", "error");
		return {
			success: false,
			error: "GitHubPort not available for PR body refresh",
			source: LOG_CONTEXT,
		};
	}
	let prNumber = input.prNumber;
	if (!prNumber) {
		const found = await findPullRequestNumber(port, repo, head);
		if (!found.ok) {
			log?.warn(LOG_CONTEXT, found.error);
			return { success: false, error: found.error, source: LOG_CONTEXT };
		}
		prNumber = found.value;
	}
	return await updateExistingPr(input as UpsertPullRequestInput, prNumber);
}
