// ─── Audit Rejection Domain Policy ───────────────────────────────
// Pure helpers for rejection identity, the `reject-N` label grammar and
// loop counting (issue #2044). No I/O — the pipeline wires the GitHub
// port around these decisions.

import { hasAuditRejectionMarker, isAuditRejectionComment } from "./audit-headings.ts";

export const REJECT_LABEL_PREFIX = "reject-";

/** The auditor's prior rejection comment, including its GitHub comment id. */
export interface PriorAuditRejection {
	id: string;
	body: string;
}

/**
 * Newest supervisor-authored rejection comment that carries an id we can
 * update. The marker gates ownership (issue #2044 audit finding #4): an
 * unmarked comment with a rejection heading — e.g. a codeowner's manual note —
 * is never selected, and id-less comments are skipped (the upsert falls back
 * to posting).
 */
export function findPriorAuditRejection(
	comments: Array<{ id?: string; body: string }>,
): PriorAuditRejection | undefined {
	for (let i = comments.length - 1; i >= 0; i--) {
		const comment = comments[i];
		if (comment?.id && isAuditRejectionComment(comment.body) && hasAuditRejectionMarker(comment.body)) {
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
 * fallback so pre-label issues self-heal on the next bump.
 */
export function countAuditRejections(
	labels: string[],
	comments: Array<{ body?: string | null }>,
): number {
	const legacyCount = comments.filter((c) => isAuditRejectionComment(c.body)).length;
	return Math.max(parseRejectCount(labels), legacyCount);
}
