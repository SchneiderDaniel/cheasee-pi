// ─── Pull-request update path (shared) ──────────────────────────
// Update-only helpers: an existing PR is refreshed, never duplicated, and a
// missing PR is a failure rather than a create. `upsertPullRequest` in
// `pull-request.ts` uses these after its list-by-branch probe.

import { failure, type Result } from "../result.ts";
import { LOG_CONTEXT, type PrNotify, type PrPortLike, type PrUpsertResult } from "./pr-types.ts";

/** The subset of the create input the update path needs. */
export interface UpdatePrInput {
	repo: string;
	head: string;
	title: string;
	body: string;
	port?: PrPortLike;
	notify?: PrNotify;
	log?: {
		error(context: string, message: string): void;
		warn(context: string, message: string): void;
	};
}

/**
 * Update an existing PR, mapping failures to a PrUpsertResult.
 *
 * Module-local in spirit: every PR write goes through this one update path.
 */
export async function updateExistingPr(
	input: UpdatePrInput,
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
		const reason = err instanceof Error ? err.message : String(err);
		return failure(`PR lookup failed: ${reason}`, LOG_CONTEXT);
	}
}

/**
 * Write a body onto an already-published PR — update-only, so a body refresh
 * can never open a second PR. `prNumber` wins; otherwise the head branch is
 * resolved and a missing PR is a failure result, never a create.
 */
export async function updatePullRequestBody(
	input: UpdatePrInput & { prNumber?: number },
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
	return await updateExistingPr(input, prNumber);
}
