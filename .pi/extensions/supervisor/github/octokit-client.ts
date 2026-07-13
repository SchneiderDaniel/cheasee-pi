// ─── OctokitClient — GitHubPort adapter ──────────────────────────
// Implements GitHubPort using @octokit/rest (REST) and @octokit/graphql (GraphQL).
// Single point of external API knowledge — no Octokit types leak to callers.

import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import type { DebugLogger } from "../lib/debug.ts";
import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../config/types.ts";
import type { RawIssueData, GitHubPort } from "./ports.ts";

// ─── Hard safety limit (migrated from comment.ts) ────────────────

const MAX_COMMENT_CHARS = 50_000;

// ─── GraphQL Query Strings ──────────────────────────────────────

const PROJECT_FIELDS_QUERY = (projectNumber: number) => `{
	viewer {
		projectV2(number: ${projectNumber}) {
			fields(first: 10) {
				nodes {
					... on ProjectV2Field { id name dataType }
					... on ProjectV2SingleSelectField { id name dataType options { id name } }
					... on ProjectV2IterationField { id name dataType }
				}
			}
		}
	}
}`;

const PROJECT_ITEMS_QUERY = (projectNumber: number, after: string | null) => {
	const afterArg = after ? `, after: "${after}"` : "";
	return `{
	viewer {
		projectV2(number: ${projectNumber}) {
			items(first: 100${afterArg}) {
				pageInfo { hasNextPage endCursor }
				nodes {
					id
					content {
						... on Issue { number url }
						... on PullRequest { number url }
					}
					fieldValues(first: 20) {
						nodes {
							... on ProjectV2ItemFieldSingleSelectValue {
								name
								field { ... on ProjectV2FieldCommon { id name } }
							}
							... on ProjectV2ItemFieldTextValue {
								text
								field { ... on ProjectV2FieldCommon { id name } }
							}
						}
					}
				}
			}
		}
	}
}`;
};

const PROJECT_ID_QUERY = (projectNumber: number) => `{
	viewer {
		projectV2(number: ${projectNumber}) {
			id
		}
	}
}`;

const DEPENDENCY_TIMELINE_QUERY = (owner: string, name: string, issueNumber: number) => `
	query {
		repository(owner: "${owner}", name: "${name}") {
			issue(number: ${issueNumber}) {
				timelineItems(itemTypes: [BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT], first: 100) {
					nodes {
						__typename
						... on BlockedByAddedEvent {
							blockingIssue { id number title state }
						}
						... on BlockedByRemovedEvent {
							blockingIssue { id number title state }
						}
					}
				}
			}
		}
	}`;

const SET_STATUS_MUTATION = (
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
) => `
	mutation {
		updateProjectV2ItemFieldValue(
			input: {
				projectId: "${projectId}"
				itemId: "${itemId}"
				fieldId: "${fieldId}"
				value: { singleSelectOptionId: "${optionId}" }
			}
		) { clientMutationId }
	}`;

// ─── GraphQL Response Types ──────────────────────────────────────

interface ProjectFieldsResponse {
	viewer?: {
		projectV2?: {
			fields?: {
				nodes?: Array<{
					id: string;
					name: string;
					dataType?: string;
					options?: Array<{ id: string; name: string }>;
				}>;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

interface ProjectItemsResponse {
	viewer?: {
		projectV2?: {
			items?: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes?: Array<{
					id: string;
					content?: { url?: string; number?: number };
					fieldValues?: {
						nodes?: Array<{
							name?: string;
							text?: string;
							field?: { id: string; name: string };
						}>;
					};
				}>;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

interface ProjectIdResponse {
	viewer?: {
		projectV2?: {
			id: string;
		};
	};
	errors?: Array<{ message: string }>;
}

interface DepsTimelineResponse {
	repository?: {
		issue?: {
			timelineItems?: {
				nodes?: Array<{
					__typename: string;
					blockingIssue?: {
						id: string;
						number: number;
						title: string;
						state: string;
					} | null;
				}>;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

// ─── OctokitClient ──────────────────────────────────────────────

export class OctokitClient implements GitHubPort {
	private octokit: Octokit;
	private _graphql: typeof graphql;
	private log: DebugLogger;

	constructor(token: string, debugLogger: DebugLogger) {
		this.octokit = new Octokit({ auth: token });
		this._graphql = graphql.defaults({
			headers: { authorization: `token ${token}` },
		});
		this.log = debugLogger;
	}

	setToken(token: string): void {
		this.octokit = new Octokit({ auth: token });
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
			if (
				err instanceof Object &&
				"status" in (err as object) &&
				(err as { status: number }).status === 404
			) {
				return null;
			}
			throw err;
		}
	}

	async getIssueWithComments(issueNum: number, repo: string): Promise<RawIssueData | null> {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

		this.log.debug("octokit", `getIssueWithComments #${issueNum}`);
		try {
			const [issueResp, commentsResp] = await Promise.all([
				this.octokit.issues.get({ owner, repo: name, issue_number: issueNum }),
				this.octokit.issues.listComments({
					owner,
					repo: name,
					issue_number: issueNum,
					per_page: 100,
				}),
			]);
			const issue = issueResp.data;
			return {
				number: issue.number,
				title: issue.title || undefined,
				body: issue.body || undefined,
				author: issue.user ? { login: issue.user.login } : undefined,
				comments: commentsResp.data.map((c) => ({
					author: c.user ? { login: c.user.login } : undefined,
					body: c.body || undefined,
				})),
			};
		} catch (err: unknown) {
			if (
				err instanceof Object &&
				"status" in (err as object) &&
				(err as { status: number }).status === 404
			) {
				return null;
			}
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

		// Hard safety limit — migrated from comment.ts
		const truncated =
			body.length > MAX_COMMENT_CHARS
				? body.slice(0, MAX_COMMENT_CHARS) +
					"\n\n---\n⚠️ **Comment truncated at 50,000 character safety limit** — a bug likely caused the full agent execution log to be included. Please report this."
				: body;

		this.log.debug("octokit", `postIssueComment #${issueNum}`, {
			bodyLen: body.length,
			truncated: body.length > MAX_COMMENT_CHARS,
		});
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

		const pr = prs[0]! as Record<string, unknown>;
		return {
			number: pr.number as number,
			hasConflict:
				(pr.mergeable as string) === "CONFLICTING" || (pr.merge_state_status as string) === "DIRTY",
			mergeable: (pr.mergeable as string) || "UNKNOWN",
			mergeStateStatus: (pr.merge_state_status as string) || "UNKNOWN",
			headRefName: (pr.head as { ref?: string })?.ref || branch,
			baseRefName: (pr.base as { ref?: string })?.ref || "main",
		};
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
								nodes?: Array<{
									name?: string;
									text?: string;
									field?: { id: string; name: string };
								}>;
							};
						}>;
				  }
				| undefined;
			if (!page) break;

			for (const n of page.nodes || []) {
				const fieldNodes = n?.fieldValues?.nodes || [];
				let status: string | undefined;
				const fv: Array<{ fieldId: string; value: string; optionId?: string }> = [];
				for (const f of fieldNodes) {
					if (f.name && f.field?.name?.toLowerCase() === "status") {
						status = f.name;
					}
					if (f.field?.id) {
						fv.push({
							fieldId: f.field.id,
							value: f.name || f.text || "",
							optionId: undefined,
						});
					}
				}
				allItems.push({
					id: n.id,
					status,
					content: n.content ? { url: n.content.url, number: n.content.number } : undefined,
					fieldValues: fv.length > 0 ? fv : undefined,
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
		if (!nodes || nodes.length === 0) {
			return { blocked: false, blockers: [] };
		}

		const lastEventByIssue = new Map<string, string>();
		for (const node of nodes) {
			const blockingId = node?.blockingIssue?.id;
			if (!blockingId) continue;
			lastEventByIssue.set(blockingId, node.__typename);
		}

		const blockers: DepsResult["blockers"] = [];
		const seenNumbers = new Set<number>();
		for (const node of nodes) {
			const issue = node.blockingIssue;
			if (!issue) continue;
			const lastEvent = lastEventByIssue.get(issue.id);
			if (lastEvent !== "BlockedByAddedEvent") continue;
			if (seenNumbers.has(issue.number)) continue;
			seenNumbers.add(issue.number);
			const state = issue.state || "UNKNOWN";
			if (state === "CLOSED") continue;
			blockers.push({
				number: issue.number,
				title: issue.title || "",
				type: "issue",
				state,
			});
		}

		return {
			blocked: blockers.length > 0,
			blockers,
		};
	}

	// ─── GraphQL helper ─────────────────────────────────────────

	private async graphqlQuery<T>(query: string): Promise<T> {
		try {
			return await (this._graphql as (q: string) => Promise<T>)(query);
		} catch (err: unknown) {
			// @octokit/graphql throws GraphqlResponseError on errors array
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`GitHub GraphQL request failed: ${msg}`);
		}
	}
}
