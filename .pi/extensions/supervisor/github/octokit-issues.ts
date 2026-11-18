// ─── Octokit Issues Adapter (issue #2098) ────────────────────────
// Issue REST operations over the shared GitHubTransport. Split out of the
// former OctokitClient god object; the comment/label half lives in
// octokit-issue-ops.ts and is inherited.

import type { RawIssueData } from "./ports.ts";
import type { IssuePort } from "./ports.ts";
import { IssueOpsBase, normalizeAndTruncateComment } from "./octokit-issue-ops.ts";
import { isNotFound } from "./parsers.ts";

export class OctokitIssues extends IssueOpsBase implements IssuePort {
	async getIssue(issueNum: number, repo: string): Promise<RawIssueData | null> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `getIssue #${issueNum}`);
		try {
			const resp = await this.transport.octokit.issues.get({
				owner,
				repo: name,
				issue_number: issueNum,
			});
			const issue = resp.data;
			return {
				number: issue.number,
				title: issue.title || undefined,
				body: issue.body || undefined,
				author: issue.user ? { login: issue.user.login } : undefined,
			};
		} catch (err: unknown) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async getIssueWithComments(issueNum: number, repo: string): Promise<RawIssueData | null> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `getIssueWithComments #${issueNum}`);
		try {
			const [issueResp, comments] = await Promise.all([
				this.transport.octokit.issues.get({ owner, repo: name, issue_number: issueNum }),
				this.listComments(issueNum, repo),
			]);
			const issue = issueResp.data;
			return {
				number: issue.number,
				title: issue.title || undefined,
				body: issue.body || undefined,
				author: issue.user ? { login: issue.user.login } : undefined,
				comments,
			};
		} catch (err: unknown) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async closeIssue(issueNum: number, repo: string): Promise<void> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `closeIssue #${issueNum}`);
		await this.transport.octokit.issues.update({
			owner,
			repo: name,
			issue_number: issueNum,
			state: "closed",
		});
	}

	async postIssueComment(issueNum: number, repo: string, body: string): Promise<void> {
		const { owner, name } = this.parseRepo(repo);

		const truncated = normalizeAndTruncateComment(body);
		this.log.debug("octokit", `postIssueComment #${issueNum}`, { bodyLen: truncated.length });
		await this.transport.octokit.issues.createComment({
			owner,
			repo: name,
			issue_number: issueNum,
			body: truncated,
		});
	}
}
