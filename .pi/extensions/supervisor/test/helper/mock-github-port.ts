// ─── Mock GitHubPort for tests ────────────────────────────────────
// Creates a lightweight stub that implements the 8-method GitHubPort.
// Each method returns a resolved promise with a sensible default
// (empty/false/null) unless overridden via constructor options.
// When trackCalls array is provided, every method invocation is
// recorded for assertion — including custom implementations.
// Default methods never throw — fully functional stub with no overrides.

import type { GitHubPort } from "../../github/ports.ts";
import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../../config/types.ts";

// ─── Call tracking ────────────────────────────────────────────────

export interface PortCall {
	method: string;
	args: unknown[];
}

export interface MockGitHubPortOptions {
	postIssueComment?: (issueNum: number, repo: string, body: string) => Promise<void>;
	getProjectFields?: (projectNumber: number) => Promise<ProjectField[]>;
	getProjectItems?: (projectNumber: number) => Promise<ProjectItem[]>;
	getProjectId?: (projectNumber: number) => Promise<string>;
	setItemStatusField?: (
		itemId: string,
		projectId: string,
		fieldId: string,
		optionId: string,
	) => Promise<void>;
	checkBlockedByDependencies?: (issueNum: number, repo: string) => Promise<DepsResult>;
	createPullRequest?: (input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}) => Promise<{ number: number }>;
	listPullRequestsForBranch?: (
		branch: string,
		repo: string,
	) => Promise<PrConflictInfo | null>;
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
			// Fallback: throw if override provided but doesn't match
			throw new Error(`No implementation for port.${method}()`);
		};

	// Default return values for unmocked methods — never throw
	const defaults = {
		postIssueComment: undefined as void,
		getProjectFields: [] as ProjectField[],
		getProjectItems: [] as ProjectItem[],
		getProjectId: "",
		setItemStatusField: undefined as void,
		checkBlockedByDependencies: { blocked: false, blockers: [] } as DepsResult,
		createPullRequest: { number: 123 },
		listPullRequestsForBranch: null as PrConflictInfo | null,
	};

	return {
		postIssueComment:
			opts?.postIssueComment
				? wrap("postIssueComment", opts.postIssueComment)
				: (async (issueNum: number, repo: string, body: string) => {
						record("postIssueComment", [issueNum, repo, body]);
						return defaults.postIssueComment;
					}) as GitHubPort["postIssueComment"],

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

		createPullRequest:
			opts?.createPullRequest
				? wrap("createPullRequest", opts.createPullRequest)
				: (async (input: {
						repo: string;
						base: string;
						head: string;
						title: string;
						body?: string;
				  }) => {
						record("createPullRequest", [input]);
						return defaults.createPullRequest;
					}) as GitHubPort["createPullRequest"],

		listPullRequestsForBranch:
			opts?.listPullRequestsForBranch
				? wrap("listPullRequestsForBranch", opts.listPullRequestsForBranch)
				: (async (branch: string, repo: string) => {
						record("listPullRequestsForBranch", [branch, repo]);
						return defaults.listPullRequestsForBranch;
					}) as GitHubPort["listPullRequestsForBranch"],
	};
}
