// ─── Issue Data Filtering (Security) ─────────────────────────────
// filterIssueData — security-critical: controls which issue data is
// visible to agents (codeowner trust gate). Isolated in its own file
// for review isolation. No Octokit or ExecFn dependency.

import type { FilteredIssueData, ProjectItem } from "../config/types.ts";
import { hasAuditRejectionMarker, isAuditRejectionComment } from "./audit-headings.ts";

// ─── Raw Issue Data (from Octokit) ───────────────────────────────

export interface RawIssueData {
	number?: number;
	title?: string;
	body?: string;
	author?: { login: string };
	comments?: Array<{ id?: string; author?: { login: string }; body?: string }>;
}

// ─── Filter Issue Data (Security) ─────────────────────────────────

export function filterIssueData(rawIssue: RawIssueData, codeowners: string[]): FilteredIssueData {
	const issueAuthor: string = rawIssue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? rawIssue?.body || "(no body)"
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments = rawIssue?.comments || [];
	const trustedComments = rawComments
		.filter((c) => {
			const commentAuthor: string = c?.author?.login || "";
			return codeowners.includes(commentAuthor);
		})
		.map((c) => ({
			author: c?.author?.login || "unknown",
			body: c?.body || "",
			id: c?.id,
		}));

	// Supervisor rejections are the pipeline's own output — retrieve them from
	// the RAW comments regardless of codeowner trust (issue #2044 audit finding
	// #1), so the upsert finds its prior comment even when the automation
	// account is not a codeowner. The marker gates ownership: an unmarked
	// comment with a rejection heading is never treated as supervisor-authored
	// (audit finding #4). Untrusted content stays out of `comments`.
	const auditRejections = rawComments
		.filter((c) => isAuditRejectionComment(c?.body) && hasAuditRejectionMarker(c?.body))
		.map((c) => ({ id: c?.id, body: c?.body || "" }));

	return {
		body,
		comments: trustedComments,
		auditRejections,
	};
}

// ─── Find Issue Item ──────────────────────────────────────────────

export function findIssueItem(items: ProjectItem[], issueNumber: number): ProjectItem | null {
	for (const item of items) {
		if (item.content?.number === issueNumber) return item;
		const url = item.content?.url || "";
		if (url.includes(`/issues/${issueNumber}`) || url.includes(`/pull/${issueNumber}`)) return item;
	}
	return null;
}
