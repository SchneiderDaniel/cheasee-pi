// ─── Audit Heading Grammar — single source of truth ──────────────
// Anchored matchers for the auditor verdict headings. Every pipeline
// producer (auditor-output.ts, shared-prompts templates, structured
// commentBody) emits the heading at body position 0, so a position-0
// match — not a substring scan — is the reliable rejection signal.
// Issue #1668: the unanchored substring regex counted quoted occurrences
// (e.g. a Test Plan body describing the refusal contract) as rejections,
// tripping the limit prematurely.

export const AUDIT_REJECTED_HEADING = "## Audit Rejected";
export const AUDIT_APPROVED_HEADING = "## Audit Approved";

/**
 * True when the body begins with the `## Audit Rejected` heading at
 * position 0. `\s*` kept over strict CommonMark `\s+` (documented
 * trade-off): a botched `##AuditRejected` is an unambiguous pipeline
 * rejection, and counting it beats dropping a real one. Mid-body quotes,
 * fenced-code lines and blockquote quotes never begin the body → false.
 */
export function isAuditRejectedComment(body: string | null | undefined): boolean {
	if (!body) return false;
	return /^##\s*Audit\s*Rejected/i.test(body);
}

/**
 * True when the body begins with the `## Audit Approved` heading at
 * position 0. Same anchoring rules as isAuditRejectedComment.
 */
export function isAuditApprovedComment(body: string | null | undefined): boolean {
	if (!body) return false;
	return /^##\s*Audit\s*Approved/i.test(body);
}

/**
 * Index of the LAST line-start occurrence of `heading` in text
 * (case-insensitive), or -1 when absent. Mid-line occurrences are
 * ignored. Used for raw agent-output scans where a heading may
 * legitimately appear after reasoning lines — the most recent wins.
 */
export function lastLineHeadingIndex(text: string, heading: string): number {
	const lowerHeading = heading.toLowerCase();
	let lastIdx = -1;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const lineEnd = text.indexOf("\n", lineStart);
		const end = lineEnd === -1 ? text.length : lineEnd;
		if (text.slice(lineStart, end).toLowerCase().startsWith(lowerHeading)) {
			lastIdx = lineStart;
		}
		if (lineEnd === -1) break;
		lineStart = lineEnd + 1;
	}
	return lastIdx;
}