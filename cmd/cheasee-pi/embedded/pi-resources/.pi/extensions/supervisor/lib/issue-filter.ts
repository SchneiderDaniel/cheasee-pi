// ─── Issue Data Filtering (Security) ─────────────────────────────
// filterIssueData — security-critical: controls which issue data is
// visible to agents (codeowner trust gate). Isolated in its own file
// for review isolation. No Octokit or ExecFn dependency.

import type { FilteredIssueData, ProjectItem } from "../config/types.ts";

// ─── Raw Issue Data (from Octokit) ───────────────────────────────

export interface RawIssueData {
	number?: number;
	title?: string;
	body?: string;
	author?: { login: string };
	comments?: Array<{ author?: { login: string }; body?: string }>;
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
		}));

	return {
		body,
		comments: trustedComments,
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
