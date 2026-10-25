// ─── Pipeline Stages — audit rejection/approval posting (issue #2044) ──
// Post or update the supervisor's audit rejection in place, retire the
// rejections it supersedes, and post approvals. Split out of
// auditor-output.ts to stay under the 500-line long-file ceiling.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, FilteredIssueData } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import {
	countAuditRejections,
	findPriorAuditRejection,
	rejectLabel,
} from "../../lib/audit-rejections.ts";

/**
 * Post or update the supervisor's audit rejection (issue #2044).
 *
 * The `reject-N` label is the durable loop counter for the in-place update
 * path, so it is written first and rolled back if the comment write fails.
 * When the label cannot be written the rejection is appended instead — the
 * legacy comment count then keeps the counter advancing, so a label outage
 * degrades to the old append behaviour instead of stalling the loop or
 * aborting the pipeline.
 *
 * Superseded rejection comments (older ones on an issue rejected before this
 * feature) are deleted only while the label counter is authoritative;
 * otherwise they are exactly what keeps the comment-count fallback growing.
 */
export async function postOrUpdateAuditRejection(
	issueNum: number,
	config: SupervisorConfig,
	body: string,
	loopFilteredData: FilteredIssueData | undefined,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) {
		collector?.push("stages", "error", "Cannot record audit rejection: GitHub port unavailable");
		return;
	}
	const rejections = loopFilteredData?.auditRejections ?? [];
	const prior = findPriorAuditRejection(rejections);

	// Resolve the counter before writing so a label outage can fall back to a
	// new comment (which grows the legacy count) instead of aborting.
	let labels: string[] | undefined;
	try {
		labels = await port.getIssueLabels(issueNum, config.repo);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to read reject labels: ${msg}`);
	}
	const current = countAuditRejections(labels ?? [], loopFilteredData?.rejectionCommentCount ?? 0);
	const next = current + 1;

	// Label first: an in-place update keeps a single rejection comment, so the
	// label is the only durable record of the increment.
	let bumped = false;
	if (labels) {
		try {
			await port.addIssueLabel(issueNum, config.repo, rejectLabel(next));
			bumped = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to record reject label: ${msg}`);
		}
	}

	const updateInPlace = !!prior && bumped;
	try {
		if (updateInPlace && prior) {
			await port.updateIssueComment(prior.id, config.repo, body);
			ctx.ui.notify("Audit rejection comment updated in place", "info");
		} else {
			await port.postIssueComment(issueNum, config.repo, body);
			ctx.ui.notify("Audit rejection comment posted", "info");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const action = updateInPlace ? "update" : "post";
		collector?.push("stages", "error", `Failed to ${action} audit rejection: ${msg}`);
		ctx.ui.notify(`Audit rejection could not be saved: ${msg}`, "error");
		// Roll back the counter bump — the rejection was not persisted, so the
		// loop must not advance — then fail closed: the next implementation run
		// would otherwise have no feedback.
		if (bumped) {
			try {
				await port.removeIssueLabel(issueNum, config.repo, rejectLabel(next));
			} catch (rollbackErr: unknown) {
				const rollbackMsg =
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				collector?.push("stages", "warn", `Failed to roll back reject label: ${rollbackMsg}`);
			}
		}
		throw new Error(`Failed to ${action} audit rejection: ${msg}`);
	}

	if (!bumped) return;
	// The label now carries the count, so stale rejections can be removed.
	await deleteSupersededRejections(
		port,
		config.repo,
		rejections,
		updateInPlace ? prior?.id : undefined,
		collector,
	);
	if (current > 0) {
		try {
			await port.removeIssueLabel(issueNum, config.repo, rejectLabel(current));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to remove stale reject label: ${msg}`);
		}
	}
}

/**
 * Delete every supervisor rejection comment except `keepId` (issue #2044):
 * older issues accumulated one rejection comment per loop, and the in-place
 * update only collapses the newest. Best effort — a failed delete must not
 * block the audit transition.
 */
async function deleteSupersededRejections(
	port: GitHubPort,
	repo: string,
	rejections: Array<{ id?: string }>,
	keepId: string | undefined,
	collector: ErrorCollector | undefined,
): Promise<void> {
	for (const rejection of rejections) {
		if (rejection.id && rejection.id !== keepId) {
			try {
				await port.deleteIssueComment(rejection.id, repo);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				collector?.push(
					"stages",
					"warn",
					`Failed to delete superseded rejection ${rejection.id}: ${msg}`,
				);
			}
		}
	}
}

/**
 * Post an approval comment, retiring any supervisor rejection it supersedes:
 * an approved issue must not keep advertising a rejection the audit cleared
 * (issue #2044).
 */
export async function postApprovalComment(
	body: string,
	notifyMessage: string,
	issueNum: number,
	config: SupervisorConfig,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	loopFilteredData: FilteredIssueData | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) return;
	try {
		await port.postIssueComment(issueNum, config.repo, body);
		ctx.ui.notify(notifyMessage, "info");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to post audit approval comment: ${msg}`);
		return;
	}
	await deleteSupersededRejections(
		port,
		config.repo,
		loopFilteredData?.auditRejections ?? [],
		undefined,
		collector,
	);
}
