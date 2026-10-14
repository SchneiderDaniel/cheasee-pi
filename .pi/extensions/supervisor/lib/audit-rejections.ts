// ─── Audit Rejection Domain Policy ───────────────────────────────
// Pure helpers for rejection identity, the `reject-N` label grammar and
// loop counting (issue #2044). No I/O — the pipeline wires the GitHub
// port around these decisions.

import { isAuditRejectionComment } from "./audit-headings.ts";

export const REJECT_LABEL_PREFIX = "reject-";

/** The auditor's prior rejection comment, including its GitHub comment id. */
export interface PriorAuditRejection {
	id: string;
	body: string;
}

/**
 * Newest rejection comment that carries an id we can update. Ownership is
 * already verified upstream (`filterIssueData` keeps only comments whose author
 * is the authenticated automation account), so no marker is required —
 * rejections posted before the marker existed must still be found and updated
 * in place. Id-less comments are skipped (the upsert falls back to posting).
 */
export function findPriorAuditRejection(
	comments: Array<{ id?: string; body: string }>,
): PriorAuditRejection | undefined {
	for (let i = comments.length - 1; i >= 0; i--) {
		const comment = comments[i];
		if (comment?.id && isAuditRejectionComment(comment.body)) {
			return { id: comment.id, body: comment.body };
		}
	}
	return undefined;
}

/** Highest N across `reject-N` labels, or 0 when none are present. */
export function parseRejectCount(labels: string[]): number {
	let max = 0;
	const re = new RegExp(`^${REJECT_LABEL_PREFIX}(\\d+)$`);
	for (const label of labels) {
		const match = re.exec(label.trim());
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max;
}

export function rejectLabel(n: number): string {
	return `${REJECT_LABEL_PREFIX}${n}`;
}

/**
 * Loop count after in-place rejection updates: `reject-N` labels are the
 * source of truth, with the legacy position-0 rejection comments as a
 * fallback so pre-label issues self-heal on the next bump. `legacyCount` is a
 * count-only total computed from RAW comments (see `filterIssueData`), so it
 * still counts unmarked legacy rejections whose bodies never reach agents
 * (issue #2044 audit finding #3).
 */
export function countAuditRejections(labels: string[], legacyCount: number): number {
	return Math.max(parseRejectCount(labels), legacyCount);
}
