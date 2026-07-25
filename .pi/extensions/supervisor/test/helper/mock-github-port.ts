// ─── Mock GitHubPort for tests ────────────────────────────────────
// Creates a lightweight stub that implements GitHubPort.
// Each method returns a resolved promise with a sensible default
// (empty/false/null) unless overridden via constructor options.
// When trackCalls array is provided, every method invocation is
// recorded for assertion — including custom implementations.

import type { GitHubPort, ClosingPrRef } from "../../github/ports.ts";
import type { RawIssueData } from "../../lib/issue-filter.ts";
import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../../config/types.ts";

// ─── Call tracking ────────────────────────────────────────────────

export interface PortCall {
	method: string;
	args: unknown[];
}

export interface MockGitHubPortOptions {
	getIssue?: (issueNum: number, repo: string) => Promise<RawIssueData | null>;
	getIssueWithComments?: (issueNum: number, repo: string) => Promise<RawIssueData | null>;
	closeIssue?: (issueNum: number, repo: string) => Promise<void>;
	postIssueComment?: (issueNum: number, repo: string, body: string) => Promise<void>;
	compareBranches?: (base: string, head: string, repo: string) => Promise<number>;
	listPullRequestsForBranch?: (
		branch: string,
		repo: string,
	) => Promise<PrConflictInfo | null>;
	createPullRequest?: (input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}) => Promise<{ number: number }>;
	updatePullRequest?: (
		prNumber: number,
		repo: string,
		body: string,
		title?: string,
	) => Promise<void>;
	getProjectFields?: (projectNumber: number) => Promise<ProjectField[]>;
	getProjectItems?: (projectNumber: number) => Promise<ProjectItem[]>;
	getProjectId?: (projectNumber: number) => Promise<string>;
	setItemStatusField?: (
		itemId: string,
		projectId: string,
		fieldId: string,
		optionId: string,
	) => Promise<void>;
	checkBlockedByDependencies?: (
		issueNum: number,
		repo: string,
	) => Promise<DepsResult>;
	getClosingPrsForIssue?: (
		issueNum: number,
		repo: string,
	) => Promise<ClosingPrRef[]>;
	setToken?: (token: string) => void;
}

// ─── Factory with call tracking ───────────────────────────────────
// Every invocation is recorded in trackCalls (if provided), including
// overridden methods. This makes it easy to assert on port call order.

export function createMockGitHubPort(
	opts?: MockGitHubPortOptions,
	trackCalls?: PortCall[],
): GitHubPort {
	const record = (method: string, args: unknown[]) => {
		if (trackCalls) trackCalls.push({ method, args });
	};

	// Helper: wrap a custom implementation with call tracking
	const wrap =
		<A extends unknown[], R>(method: string, fn?: (...a: A) => R) =>
		(...args: A): R => {
			record(method, args);
			if (fn) return fn(...args);
			throw new Error(`No implementation for port.${method}()`);
		};

	// Default return values for unmocked methods
	const defaults = {
		getIssue: null as RawIssueData | null,
		getIssueWithComments: null as RawIssueData | null,
		closeIssue: undefined as void,
		postIssueComment: undefined as void,
		compareBranches: 0,
		listPullRequestsForBranch: null as PrConflictInfo | null,
		createPullRequest: { number: 123 },
		updatePullRequest: undefined as void,
		getProjectFields: [] as ProjectField[],
		getProjectItems: [] as ProjectItem[],
		getProjectId: "",
		setItemStatusField: undefined as void,
		checkBlockedByDependencies: { blocked: false, blockers: [] } as DepsResult,
	getClosingPrsForIssue: [] as ClosingPrRef[],
	};

	return {
		getIssue:
			opts?.getIssue
				? wrap("getIssue", opts.getIssue)
				: (async (issueNum: number, repo: string) => {
						record("getIssue", [issueNum, repo]);
						return defaults.getIssue;
					}) as GitHubPort["getIssue"],

		getIssueWithComments:
			opts?.getIssueWithComments
				? wrap("getIssueWithComments", opts.getIssueWithComments)
				: (async (issueNum: number, repo: string) => {
						record("getIssueWithComments", [issueNum, repo]);
						return defaults.getIssueWithComments;
					}) as GitHubPort["getIssueWithComments"],

		closeIssue:
			opts?.closeIssue
				? wrap("closeIssue", opts.closeIssue)
				: (async (issueNum: number, repo: string) => {
						record("closeIssue", [issueNum, repo]);
						return defaults.closeIssue;
					}) as GitHubPort["closeIssue"],

		postIssueComment:
			opts?.postIssueComment
				? wrap("postIssueComment", opts.postIssueComment)
				: (async (issueNum: number, repo: string, body: string) => {
						record("postIssueComment", [issueNum, repo, body]);
						return defaults.postIssueComment;
					}) as GitHubPort["postIssueComment"],

		compareBranches:
			opts?.compareBranches
				? wrap("compareBranches", opts.compareBranches)
				: (async (base: string, head: string, repo: string) => {
						record("compareBranches", [base, head, repo]);
						return defaults.compareBranches;
					}) as GitHubPort["compareBranches"],

		listPullRequestsForBranch:
			opts?.listPullRequestsForBranch
				? wrap("listPullRequestsForBranch", opts.listPullRequestsForBranch)
				: (async (branch: string, repo: string) => {
						record("listPullRequestsForBranch", [branch, repo]);
						return defaults.listPullRequestsForBranch;
					}) as GitHubPort["listPullRequestsForBranch"],

		createPullRequest:
			opts?.createPullRequest
				? wrap("createPullRequest", opts.createPullRequest)
				: (async (input: { repo: string; base: string; head: string; title: string; body?: string }) => {
						record("createPullRequest", [input]);
						return defaults.createPullRequest;
					}) as GitHubPort["createPullRequest"],

		updatePullRequest:
			opts?.updatePullRequest
				? wrap("updatePullRequest", opts.updatePullRequest)
				: (async (prNumber: number, repo: string, body: string, title?: string) => {
						record("updatePullRequest", [prNumber, repo, body, title]);
						return defaults.updatePullRequest;
					}) as GitHubPort["updatePullRequest"],

		getProjectFields:
			opts?.getProjectFields
				? wrap("getProjectFields", opts.getProjectFields)
				: (async (projectNumber: number) => {
						record("getProjectFields", [projectNumber]);
						return defaults.getProjectFields;
					}) as GitHubPort["getProjectFields"],

		getProjectItems:
			opts?.getProjectItems
				? wrap("getProjectItems", opts.getProjectItems)
				: (async (projectNumber: number) => {
						record("getProjectItems", [projectNumber]);
						return defaults.getProjectItems;
					}) as GitHubPort["getProjectItems"],

		getProjectId:
			opts?.getProjectId
				? wrap("getProjectId", opts.getProjectId)
				: (async (projectNumber: number) => {
						record("getProjectId", [projectNumber]);
						return defaults.getProjectId;
					}) as GitHubPort["getProjectId"],

		setItemStatusField:
			opts?.setItemStatusField
				? wrap("setItemStatusField", opts.setItemStatusField)
				: (async (itemId: string, projectId: string, fieldId: string, optionId: string) => {
						record("setItemStatusField", [itemId, projectId, fieldId, optionId]);
						return defaults.setItemStatusField;
					}) as GitHubPort["setItemStatusField"],

		checkBlockedByDependencies:
			opts?.checkBlockedByDependencies
				? wrap("checkBlockedByDependencies", opts.checkBlockedByDependencies)
				: (async (issueNum: number, repo: string) => {
						record("checkBlockedByDependencies", [issueNum, repo]);
						return defaults.checkBlockedByDependencies;
					}) as GitHubPort["checkBlockedByDependencies"],

		getClosingPrsForIssue:
			opts?.getClosingPrsForIssue
				? wrap("getClosingPrsForIssue", opts.getClosingPrsForIssue)
				: (async (issueNum: number, repo: string) => {
						record("getClosingPrsForIssue", [issueNum, repo]);
						return defaults.getClosingPrsForIssue;
					}) as GitHubPort["getClosingPrsForIssue"],

		setToken: opts?.setToken ?? ((_token: string) => {}),
	};
}
