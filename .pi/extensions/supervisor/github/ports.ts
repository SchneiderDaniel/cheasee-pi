// ─── GitHub Port Interface ────────────────────────────────────────
// Domain-owned port for GitHub operations. Pipeline code depends only
// on this interface — zero Octokit imports beyond the adapter.

import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../config/types.ts";
import type { RawIssueData } from "../lib/issue-filter.ts";
export type { RawIssueData };
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OctokitClient } from "./octokit-client.ts";
import { getDebugLogger } from "../lib/debug.ts";

// ─── Closing PR Reference ───────────────────────────────────────

/** A reference to a pull request that targets or resolves this issue. */
export interface ClosingPrRef {
	number: number;
	/** Commit SHA (merge commit for merged PRs, head SHA for open PRs). */
	sha: string;
	/** How this PR was found: via closing keyword on the issue, or by matching branch head. */
	source: "closing-keyword" | "branch-head";
	/** Branch name of the PR head (for open PRs). */
	branch: string;
}

// ─── GitHub Port ─────────────────────────────────────────────────

export interface GitHubPort {
	/** Fetch issue by number. Returns null if 404. */
	getIssue(issueNum: number, repo: string): Promise<RawIssueData | null>;

	/** Fetch issue including all comments (with authors). */
	getIssueWithComments(issueNum: number, repo: string): Promise<RawIssueData | null>;

	/** Close an issue. */
	closeIssue(issueNum: number, repo: string): Promise<void>;

	/** Post a comment on an issue. Body must be < 50K chars. */
	postIssueComment(issueNum: number, repo: string, body: string): Promise<void>;

	/** Compare two branches. Returns ahead_by count. */
	compareBranches(base: string, head: string, repo: string): Promise<number>;

	/** List PRs for a branch. Returns conflict info or null if no PR. */
	listPullRequestsForBranch(branch: string, repo: string): Promise<PrConflictInfo | null>;

	/** Create a pull request. */
	createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }>;

	/** Update PR body (and optionally title). */
	updatePullRequest(
		prNumber: number,
		repo: string,
		body: string,
		title?: string,
	): Promise<void>;

	/** Get ProjectV2 fields. */
	getProjectFields(projectNumber: number): Promise<ProjectField[]>;

	/** Get ProjectV2 items (auto-paginated). */
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

	/**
	 * Get PRs referencing this issue via closing keywords ("Closes #N").
	 * Returns an empty array if no closing PRs are found.
	 * Fail-open: returns empty array on error (does not throw).
	 */
	getClosingPrsForIssue(issueNum: number, repo: string): Promise<ClosingPrRef[]>;

	/** Update the auth token for long-running sessions. */
	setToken(token: string): void;
}

// ─── Token Resolution ────────────────────────────────────────────

function resolveToken(): string | null {
	if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim().length > 0) {
		return process.env.GH_TOKEN.trim();
	}
	try {
		const configPath = join(homedir(), ".config", "gh", "hosts.yml");
		const yml = readFileSync(configPath, "utf8");
		const match = yml.match(/oauth_token:\s+(\S+)/);
		return match ? match[1]!.trim() : null;
	} catch {
		return null;
	}
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a GitHubPort instance by resolving auth from environment or
 * ~/.config/gh/hosts.yml fallback. Throws if no token is found.
 */
export function createGitHubPort(): GitHubPort {
	const token = resolveToken();
	if (!token) {
		throw new Error(
			"GitHub token not found. Set GH_TOKEN environment variable or " +
				"ensure ~/.config/gh/hosts.yml contains a valid oauth_token for github.com.",
		);
	}
	const log = getDebugLogger();
	return new OctokitClient(token, log.child("github"));
}
