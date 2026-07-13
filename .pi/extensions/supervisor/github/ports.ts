// ─── GitHub Port Interface ────────────────────────────────────────
// Domain-owned port for GitHub operations. Pipeline code depends only
// on this interface — no direct gh() / ghJson() / ghGraphQL() imports.
//
// 8 methods covering exactly the ops the pipeline uses today:
// project board, comments, PRs, dependency checking.
// Pure utilities (findIssueItem, filterIssueData) stay outside — no I/O.

import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../config/types.ts";

/** GitHub operations port — adapter boundary for the supervisor pipeline. */
export interface GitHubPort {
	/** Post a comment on an issue. Body must be < 50K chars. */
	postIssueComment(issueNum: number, repo: string, body: string): Promise<void>;

	/** Get ProjectV2 fields for a project. */
	getProjectFields(projectNumber: number): Promise<ProjectField[]>;

	/** Get ProjectV2 items for a project (auto-paginated). */
	getProjectItems(projectNumber: number): Promise<ProjectItem[]>;

	/** Get ProjectV2 node ID. */
	getProjectId(projectNumber: number): Promise<string>;

	/** Set a single-select status field on a project item. */
	setItemStatusField(
		itemId: string,
		projectId: string,
		fieldId: string,
		optionId: string,
	): Promise<void>;

	/** Check if an issue is blocked by unresolved dependencies. */
	checkBlockedByDependencies(issueNum: number, repo: string): Promise<DepsResult>;

	/** Create a pull request. */
	createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }>;

	/** List PRs for a branch. Returns conflict info or null if no PR. */
	listPullRequestsForBranch(branch: string, repo: string): Promise<PrConflictInfo | null>;
}
