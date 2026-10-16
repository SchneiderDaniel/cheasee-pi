// ─── OctokitClient — GitHubPort adapter ──────────────────────────
// Implements GitHubPort using @octokit/rest (REST) and @octokit/graphql (GraphQL).
// Single point of external API knowledge — no Octokit types leak to callers.

import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import type { DebugLogger } from "../lib/debug.ts";
import type {
	ProjectField,
	ProjectItem,
	DepsResult,
	PrConflictInfo,
	ProjectFieldValueNode,
} from "../config/types.ts";
import type { RawIssueData, GitHubPort, ClosingPrRef } from "./ports.ts";
import { IssueOpsBase, normalizeAndTruncateComment } from "./octokit-issue-ops.ts";
import {
	parseDepsTimeline,
	extractProjectItemFields,
	isNotFound,
	mapRestPrToConflictInfo,
} from "./parsers.ts";
import {
	PROJECT_FIELDS_QUERY,
	PROJECT_ITEMS_QUERY,
	PROJECT_ID_QUERY,
	DEPENDENCY_TIMELINE_QUERY,
	SET_STATUS_MUTATION,
	type ProjectFieldsResponse,
	type ProjectItemsResponse,
	type ProjectIdResponse,
	type DepsTimelineResponse,
} from "./octokit-queries.ts";

// ─── Public re-exports (issue #2001 split) ──────────────────────
// mapRestPrToConflictInfo and its response-reading helper live in parsers.ts;
// re-exported here so existing importers keep their path.
export { mapRestPrToConflictInfo } from "./parsers.ts";

// ─── OctokitClient ──────────────────────────────────────────────

export class OctokitClient extends IssueOpsBase implements GitHubPort {
	constructor(token: string, debugLogger: DebugLogger) {
		super();
		this.octokit = new Octokit({ auth: token, headers: { "X-GitHub-Api-Version": "2026-03-10" } });
		this._graphql = graphql.defaults({
			headers: { authorization: `token ${token}` },
		});
		this.log = debugLogger;
	}

	setToken(token: string): void {
		this.octokit = new Octokit({ auth: token, headers: { "X-GitHub-Api-Version": "2026-03-10" } });
		this._graphql = graphql.defaults({
			headers: { authorization: `token ${token}` },
		});
	}

	// ─── REST Operations ────────────────────────────────────────

	async getIssue(issueNum: number, repo: string): Promise<RawIssueData | null> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `getIssue #${issueNum}`);
		try {
			const resp = await this.octokit.issues.get({
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
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `getIssueWithComments #${issueNum}`);
		try {
			const [issueResp, comments] = await Promise.all([
				this.octokit.issues.get({ owner, repo: name, issue_number: issueNum }),
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
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `closeIssue #${issueNum}`);
		await this.octokit.issues.update({
			owner,
			repo: name,
			issue_number: issueNum,
			state: "closed",
		});
	}

	async postIssueComment(issueNum: number, repo: string, body: string): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		const truncated = normalizeAndTruncateComment(body);
		this.log.debug("octokit", `postIssueComment #${issueNum}`, { bodyLen: truncated.length });
		await this.octokit.issues.createComment({
			owner,
			repo: name,
			issue_number: issueNum,
			body: truncated,
		});
	}

	async compareBranches(base: string, head: string, repo: string): Promise<number> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `compareBranches ${base}...${head}`);
		const resp = await this.octokit.repos.compareCommits({
			owner,
			repo: name,
			base,
			head,
		});
		return resp.data.ahead_by;
	}

	async listPullRequestsForBranch(branch: string, repo: string): Promise<PrConflictInfo | null> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `listPullRequestsForBranch ${branch}`);
		const resp = await this.octokit.pulls.list({
			owner,
			repo: name,
			head: `${owner}:${branch}`,
			state: "open",
			per_page: 1,
		});
		const prs = resp.data;
		if (!prs || prs.length === 0) return null;

		return mapRestPrToConflictInfo(prs[0]! as Record<string, unknown>, branch, "main");
	}

	async createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }> {
		const [owner, name] = input.repo.split("/");
		if (!owner || !name)
			throw new Error(`Invalid repo format: ${input.repo} (expected owner/name)`);

		this.log.debug("octokit", `createPullRequest ${input.head} → ${input.base}`);
		const resp = await this.octokit.pulls.create({
			owner,
			repo: name,
			base: input.base,
			head: input.head,
			title: input.title,
			body: input.body,
		});
		return { number: resp.data.number };
	}

	async updatePullRequest(
		prNumber: number,
		repo: string,
		body: string,
		title?: string,
	): Promise<void> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `updatePullRequest #${prNumber}`);
		await this.octokit.pulls.update({
			owner,
			repo: name,
			pull_number: prNumber,
			body,
			title,
		});
	}

	// ─── GraphQL Operations ─────────────────────────────────────

	async getProjectFields(projectNumber: number): Promise<ProjectField[]> {
		this.log.debug("octokit", `getProjectFields #${projectNumber}`);
		const resp = await this.graphqlQuery<ProjectFieldsResponse>(
			PROJECT_FIELDS_QUERY(projectNumber),
		);
		const nodes = resp?.viewer?.projectV2?.fields?.nodes || [];
		return nodes.map((n) => ({
			id: n.id,
			name: n.name,
			type: n.dataType || "UNKNOWN",
			options: n.options || undefined,
		}));
	}

	async getProjectItems(projectNumber: number): Promise<ProjectItem[]> {
		this.log.debug("octokit", `getProjectItems #${projectNumber}`);
		const allItems: ProjectItem[] = [];
		let after: string | null = null;
		let hasNextPage = true;

		while (hasNextPage) {
			const resp = (await this.graphqlQuery<ProjectItemsResponse>(
				PROJECT_ITEMS_QUERY(projectNumber, after),
			)) as ProjectItemsResponse;
			const page = resp?.viewer?.projectV2?.items as
				| {
						pageInfo: { hasNextPage: boolean; endCursor: string | null };
						nodes?: Array<{
							id: string;
							content?: { url?: string; number?: number };
							fieldValues?: {
								nodes?: ProjectFieldValueNode[];
							};
						}>;
				  }
				| undefined;
			if (!page) break;

			for (const n of page.nodes || []) {
				const { status, fieldValues } = extractProjectItemFields(n?.fieldValues?.nodes);
				allItems.push({
					id: n.id,
					status,
					content: n.content ? { url: n.content.url, number: n.content.number } : undefined,
					fieldValues,
				});
			}

			hasNextPage = page.pageInfo?.hasNextPage ?? false;
			after = page.pageInfo?.endCursor ?? null;
		}

		return allItems;
	}

	async getProjectId(projectNumber: number): Promise<string> {
		this.log.debug("octokit", `getProjectId #${projectNumber}`);
		const resp = await this.graphqlQuery<ProjectIdResponse>(PROJECT_ID_QUERY(projectNumber));
		return resp?.viewer?.projectV2?.id || "";
	}

	async setItemStatusField(
		itemId: string,
		projectId: string,
		fieldId: string,
		optionId: string,
	): Promise<void> {
		this.log.debug("octokit", "setItemStatusField", {
			itemId: itemId.slice(0, 16) + "...",
			optionId: optionId.slice(0, 16) + "...",
		});
		await this.graphqlQuery(SET_STATUS_MUTATION(itemId, projectId, fieldId, optionId));
	}

	async checkBlockedByDependencies(issueNum: number, repo: string): Promise<DepsResult> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `checkBlockedByDependencies #${issueNum}`);
		const resp = await this.graphqlQuery<DepsTimelineResponse>(
			DEPENDENCY_TIMELINE_QUERY(owner, name, issueNum),
		);

		if (resp?.errors && resp.errors.length > 0) {
			const msgs = resp.errors.map((e) => e.message).join("; ");
			throw new Error(`GitHub GraphQL error: ${msgs}`);
		}

		const nodes = resp?.repository?.issue?.timelineItems?.nodes;
		return parseDepsTimeline(nodes);
	}

	async getClosingPrsForIssue(issueNum: number, repo: string): Promise<ClosingPrRef[]> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `getClosingPrsForIssue #${issueNum}`);

		try {
			// Search for ALL PRs referencing this issue (open, closed, merged).
			// The handler filters by state as needed: open PRs for case 3 (leave
			// open for review), merged/closed PRs for case 2 (resolved-by info).
			const resp = await this.octokit.search.issuesAndPullRequests({
				q: `repo:${owner}/${name} "#${issueNum}" type:pr`,
				sort: "updated",
				order: "desc",
				per_page: 5,
			});

			const refs: ClosingPrRef[] = [];
			for (const item of resp.data.items) {
				if (!item.number) continue;

				// Get detailed PR info to find head branch, merge commit, and state
				try {
					const prResp = await this.octokit.pulls.get({
						owner,
						repo: name,
						pull_number: item.number,
					});
					const pr = prResp.data;
					const sha = pr.merge_commit_sha || (pr.head as { sha?: string })?.sha || "";
					const branch = (pr.head as { ref?: string })?.ref || "";
					const state = pr.merged_at
						? ("merged" as const)
						: pr.state === "closed"
							? ("closed" as const)
							: ("open" as const);

					// Determine source: check if PR body contains closing keywords
					const body = pr.body || "";
					const closingPattern = new RegExp(
						`(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s*#${issueNum}\\b`,
						"i",
					);
					const source = closingPattern.test(body) ? "closing-keyword" : "branch-head";

					refs.push({ number: item.number, sha, source, branch, state });
				} catch {
					// If we can't get PR details, still include with empty sha/branch
					refs.push({
						number: item.number,
						sha: "",
						source: "branch-head",
						branch: "",
						state: "open",
					});
				}
			}

			return refs;
		} catch (err: unknown) {
			// Fail-open: log warning and return empty array
			const msg = err instanceof Error ? err.message : String(err);
			this.log.warn("octokit", `getClosingPrsForIssue failed: ${msg}`);
			return [];
		}
	}

	// ─── GraphQL helper ─────────────────────────────────────────

	protected async graphqlQuery<T>(query: string): Promise<T> {
		try {
			return await (this._graphql as (q: string) => Promise<T>)(query);
		} catch (err: unknown) {
			// @octokit/graphql throws GraphqlResponseError on errors array
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`GitHub GraphQL request failed: ${msg}`);
		}
	}
}
