// ─── Issue comment + label operations (issue #2044) ──────────────
// Split out of octokit-client.ts so the adapter stays within its
// 15-function CodeFlow ceiling. OctokitClient extends IssueOpsBase; the
// base reads the octokit/graphql handles it injects and the subclass owns.

import type { Octokit } from "@octokit/rest";
import type { graphql } from "@octokit/graphql";
import type { DebugLogger } from "../lib/debug.ts";
import { normalizeEscapes } from "../agent/output.ts";
import { isNotFound } from "./parsers.ts";
import { UPDATE_ISSUE_COMMENT_MUTATION } from "./octokit-queries.ts";

const MAX_COMMENT_CHARS = 50_000;

/**
 * Normalize escaped newlines (regression fix #1663) and enforce the 50K
 * safety limit. Shared by post and update so both paths behave identically.
 */
export function normalizeAndTruncateComment(body: string): string {
	const normalized = normalizeEscapes(body);
	if (normalized.length <= MAX_COMMENT_CHARS) return normalized;
	return (
		normalized.slice(0, MAX_COMMENT_CHARS) +
		"\n\n---\n⚠️ **Comment truncated at 50,000 character safety limit** — a bug likely caused the full agent execution log to be included. Please report this."
	);
}

/**
 * Issue comment + label operations mixed into OctokitClient. The subclass
 * assigns the protected handles in its constructor.
 */
export abstract class IssueOpsBase {
	protected octokit!: Octokit;
	protected _graphql!: typeof graphql;
	protected log!: DebugLogger;

	/** Provided by the concrete adapter (OctokitClient.graphqlQuery). */
	protected abstract graphqlQuery<T>(query: string): Promise<T>;

	// Update an audit rejection in place (issue #2044). The comment id handle
	// from gh-CLI JSON may be a GraphQL node id (`IC_…`) or the REST database
	// id — dispatch on the representation so either source works.
	async updateIssueComment(commentId: string, repo: string, body: string): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		const truncated = normalizeAndTruncateComment(body);
		this.log.debug("octokit", `updateIssueComment ${commentId}`, { bodyLen: truncated.length });
		if (/^\d+$/.test(commentId)) {
			await this.octokit.issues.updateComment({
				owner,
				repo: name,
				comment_id: Number(commentId),
				body: truncated,
			});
			return;
		}
		await this.graphqlQuery(UPDATE_ISSUE_COMMENT_MUTATION(commentId, truncated));
	}

	// List every comment, auto-paginated (issue #2044 audit finding #4): the
	// prior rejection can sit beyond the first page that `gh issue view` returns.
	async listComments(
		issueNum: number,
		repo: string,
	): Promise<Array<{ id?: string; author?: { login: string }; body?: string }>> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `listComments #${issueNum}`);
		const comments: Array<{ id?: string; author?: { login: string }; body?: string }> = [];
		for (let page = 1; ; page++) {
			const resp = await this.octokit.issues.listComments({
				owner,
				repo: name,
				issue_number: issueNum,
				per_page: 100,
				page,
			});
			for (const c of resp.data) {
				comments.push({
					id: c.id != null ? String(c.id) : undefined,
					author: c.user ? { login: c.user.login } : undefined,
					body: c.body || undefined,
				});
			}
			if (resp.data.length < 100) break;
		}
		return comments;
	}

	// Login of the authenticated token owner — used to verify that a
	// marker-tagged rejection was authored by this automation account.
	async getAuthenticatedLogin(): Promise<string> {
		const resp = await this.octokit.users.getAuthenticated();
		return resp.data.login;
	}

	async getIssueLabels(issueNum: number, repo: string): Promise<string[]> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `getIssueLabels #${issueNum}`);
		const labels: string[] = [];
		for (let page = 1; ; page++) {
			const resp = await this.octokit.issues.listLabelsOnIssue({
				owner,
				repo: name,
				issue_number: issueNum,
				per_page: 100,
				page,
			});
			for (const label of resp.data) labels.push(label.name);
			if (resp.data.length < 100) break;
		}
		return labels;
	}

	async addIssueLabel(issueNum: number, repo: string, label: string): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `addIssueLabel #${issueNum} ${label}`);
		await this.octokit.issues.addLabels({
			owner,
			repo: name,
			issue_number: issueNum,
			labels: [label],
		});
	}

	async removeIssueLabel(issueNum: number, repo: string, label: string): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `removeIssueLabel #${issueNum} ${label}`);
		try {
			await this.octokit.issues.removeLabel({
				owner,
				repo: name,
				issue_number: issueNum,
				name: label,
			});
		} catch (err: unknown) {
			// A missing label is the desired end state — idempotent.
			if (isNotFound(err)) return;
			throw err;
		}
	}

	// Delete a superseded supervisor rejection comment (issue #2044). Used to
	// collapse the many rejections an older issue accumulated into one.
	async deleteIssueComment(commentId: string, repo: string): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `deleteIssueComment ${commentId}`);
		try {
			await this.octokit.issues.deleteComment({
				owner,
				repo: name,
				comment_id: Number(commentId),
			});
		} catch (err: unknown) {
			// An already-deleted comment is the desired end state — idempotent.
			if (isNotFound(err)) return;
			throw err;
		}
	}
}
