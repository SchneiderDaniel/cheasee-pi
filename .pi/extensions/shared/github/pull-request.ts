// ─── Pull-request create-or-update (shared) ─────────────────────
// Extracted from supervisor/pipeline/pr-creation.ts (issue #2138) so the
// goal-loop extension publishes PRs with the identical idempotent sequence:
// list-by-branch → update body when a PR exists, else create with retries.
//
// Logging and notification are injected (with no-op defaults), keeping this
// module free of either extension's concrete logger. `markReadyForReview` is
// deliberately NOT here: the REST API silently ignores `draft: false`, so
// un-drafting is GraphQL-only and belongs to the caller's adapter.

import { LOG_CONTEXT, MAX_PR_CREATE_RETRIES, RETRY_BASE_DELAY_MS } from "./pr-types.ts";
import type { PrLogger, PrNotify, PrPortLike, PrUpsertResult } from "./pr-types.ts";
import { updateExistingPr } from "./pr-update.ts";

export type { PrLogger, PrNotify, PrPortLike, PrUpsertResult } from "./pr-types.ts";
export { findPullRequestNumber, updateExistingPr, updatePullRequestBody } from "./pr-update.ts";

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

/** A fully populated input: the optional ports are already defaulted. */
type NormalizedInput = UpsertPullRequestInput & {
	port: PrPortLike;
	notify: PrNotify;
	log: PrLogger;
	sleep: (ms: number) => Promise<void>;
};

const NOOP_LOG: PrLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOOP_NOTIFY: PrNotify = () => {};
const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Fill in every no-op port once, so no call site needs an optional chain. */
function normalize(input: UpsertPullRequestInput): NormalizedInput {
	return {
		...input,
		port: input.port!,
		notify: input.notify ?? NOOP_NOTIFY,
		log: input.log ?? NOOP_LOG,
		sleep: input.sleep ?? defaultSleep,
	};
}

/** Wait before retry `attempt` (exponential backoff, logged). */
async function backoff(attempt: number, input: NormalizedInput): Promise<void> {
	if (attempt === 0) return;
	const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
	input.log.info(
		LOG_CONTEXT,
		`Retry attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} after ${delayMs}ms`,
	);
	await input.sleep(delayMs);
}

/** `value instanceof Error ? message : String(value)`. */
function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Re-list after an "already exists" create error and update instead of burning
 * the retry budget on a create that can never succeed.
 */
async function resolveRace(input: NormalizedInput, lastError: string): Promise<PrUpsertResult> {
	let raced: { number: number } | null = null;
	try {
		raced = await input.port.listPullRequestsForBranch(input.head, input.repo);
	} catch (relErr: unknown) {
		input.log.warn(LOG_CONTEXT, `Re-list after "already exists" failed: ${reasonOf(relErr)}`);
	}
	if (!raced) {
		input.log.error(LOG_CONTEXT, `PR exists per create error but not on re-list: ${lastError}`);
		input.notify(`Failed to create PR: ${lastError}`, "error");
		return { success: false, error: lastError, source: LOG_CONTEXT };
	}
	input.log.info(LOG_CONTEXT, `PR #${raced.number} appeared — updating instead of creating`);
	return await updateExistingPr(input, raced.number);
}

/** Create with one retry; an "already exists" error re-lists instead. */
async function createWithRetry(input: NormalizedInput): Promise<PrUpsertResult> {
	let lastError: string | undefined;
	for (let attempt = 0; attempt < MAX_PR_CREATE_RETRIES; attempt++) {
		await backoff(attempt, input);
		try {
			const prResult = await input.port.createPullRequest({
				repo: input.repo,
				base: input.base,
				head: input.head,
				title: input.title,
				body: input.body,
			});
			input.log.info(LOG_CONTEXT, `PR #${prResult.number} created`);
			input.notify(`PR #${prResult.number} created`, "info");
			return { success: true, prNumber: prResult.number, source: LOG_CONTEXT };
		} catch (prErr: unknown) {
			lastError = reasonOf(prErr);
			input.log.warn(
				LOG_CONTEXT,
				`Attempt ${attempt + 1}/${MAX_PR_CREATE_RETRIES} failed: ${lastError}`,
			);
			if (/already exists/i.test(lastError)) return await resolveRace(input, lastError);
		}
	}
	const errorMsg = lastError || "Unknown error during PR creation";
	input.log.error(LOG_CONTEXT, `All ${MAX_PR_CREATE_RETRIES} attempts failed: ${errorMsg}`);
	input.notify(`Failed to create PR after ${MAX_PR_CREATE_RETRIES} attempts: ${errorMsg}`, "error");
	return { success: false, error: errorMsg, source: LOG_CONTEXT };
}

/**
 * Idempotent create-or-update of the PR for one branch.
 *
 * Existing PR → update body (never a second PR). Otherwise create with one
 * retry.
 */
export async function upsertPullRequest(input: UpsertPullRequestInput): Promise<PrUpsertResult> {
	const { port, notify, log } = input;
	if (!port) {
		log?.warn(LOG_CONTEXT, "Port not available — cannot create or update PR");
		notify?.("GitHubPort not available for PR creation", "error");
		return {
			success: false,
			error: "GitHubPort not available for PR creation",
			source: LOG_CONTEXT,
		};
	}
	const normalized = normalize(input);

	let existingPr: { number: number } | null = null;
	try {
		existingPr = await port.listPullRequestsForBranch(input.head, input.repo);
	} catch (checkErr: unknown) {
		const reason = reasonOf(checkErr);
		normalized.log.warn(LOG_CONTEXT, `PR conflict check failed: ${reason}`);
		normalized.notify(
			`PR conflict check failed: ${reason} — attempting PR creation anyway`,
			"warning",
		);
	}

	if (!existingPr) return await createWithRetry(normalized);
	normalized.log.info(LOG_CONTEXT, `PR #${existingPr.number} already exists — updating body`);
	return await updateExistingPr(normalized, existingPr.number);
}
