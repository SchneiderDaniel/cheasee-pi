// ─── Issue Data Filtering (Security) ─────────────────────────────
// filterIssueData — security-critical: controls which issue data is
// visible to agents (codeowner trust gate). Isolated in its own file
// for review isolation. No Octokit or ExecFn dependency.

import type { FilteredIssueData, ProjectItem } from "../config/types.ts";
import { isAuditRejectionComment } from "./audit-headings.ts";

// ─── Raw Issue Data (from Octokit) ───────────────────────────────

export interface RawIssueData {
	number?: number;
	title?: string;
	body?: string;
	author?: { login: string };
	comments?: Array<{ id?: string; author?: { login: string }; body?: string }>;
}

// ─── Filter Issue Data (Security) ─────────────────────────────────

export function filterIssueData(
	rawIssue: RawIssueData,
	codeowners: string[],
	automationLogin?: string,
): FilteredIssueData {
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
	// account is not a codeowner. Ownership is verified by AUTHOR, not by the
	// hidden marker (this round's finding): rejections posted before the marker
	// existed must still be re-verified and updated in place, and the public
	// marker could be forged. Authoring account is the authenticated automation
	// login, so other users' comments are never selected; with no resolved login
	// the rejections are withheld (fail closed → a new rejection is posted
	// instead of an update). Bodies of selected rejections are supervisor-owned
	// and stay out of the trust-filtered `comments` list.
	const auditRejections = rawComments
		.filter(
			(c) =>
				!!automationLogin &&
				isAuditRejectionComment(c?.body) &&
				(c?.author?.login || "") === automationLogin,
		)
		.map((c) => ({ id: c?.id, body: c?.body || "" }));

	// Legacy loop-count fallback: total position-0 rejection comments authored
	// by the authenticated automation account, marked or pre-marker. Filtering
	// by author stops a non-automation commenter from faking rejections to trip
	// `maxRejections`; with no resolved identity nothing counts (callers stop
	// instead of using an unverifiable count).
	const rejectionCommentCount = auditRejections.length;

	return {
		body,
		comments: trustedComments,
		auditRejections,
		rejectionCommentCount,
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
