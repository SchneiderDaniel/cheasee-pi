// ─── Shared fixtures: developer PR upsert suite (issue #1827) ────
// Extracted so the stage suite (developer-pr-upsert.test.mts) and the
// wiring suite (developer-pr-wiring.test.mts) describe one config, one
// mock pi/ctx pair and one run result instead of copy-pasting them.
//
// Not named `*.test.mts`, so `node --test` never loads it as a suite.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	AgentRunResult,
	FilteredIssueData,
	PipelineAgentResult,
} from "../../config/types.ts";
import type { PortCall } from "./mock-github-port.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

export const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

export const developerResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 1200,
	tokenCount: 900,
	toolCount: 12,
	model: "anthropic/claude-sonnet",
};

export interface ExecCall {
	cmd: string;
	args: string[];
}

/** Exec mock that resolves — an unscripted call yields a clean no-op git run. */
export function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls: ExecCall[] = [],
): ExtensionAPI {
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], _opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args ?? [] });
			return Promise.resolve(results[idx++] ?? { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

export function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_s: string, t: string) => t } },
	} as unknown as ExtensionCommandContext;
}

export function makeNotify(): { calls: { message: string; level: string }[]; notify: NotifyFn } {
	const calls: { message: string; level: string }[] = [];
	return {
		calls,
		notify: {
			info: (message: string) => calls.push({ message, level: "info" }),
			error: (message: string) => calls.push({ message, level: "error" }),
		},
	};
}

export function prCalls(calls: PortCall[]): PortCall[] {
	return calls.filter((c) =>
		["listPullRequestsForBranch", "createPullRequest", "updatePullRequest"].includes(c.method),
	);
}

export const baseDeps = {
	issueNum: 42,
	issueTitle: "Test issue",
	config: mockConfig,
	worktreePath: "/repo/worktree",
	worktreeBranch: "worktree-git-issue-42-test",
	agentResults: [developerResult],
};

export const baseRunResult: AgentRunResult = {
	output: "",
	success: true,
	agentName: "developer",
	toolCount: 5,
	tokenCount: 2000,
	durationMs: 10000,
	textOutput: "IMPLEMENTATION_COMPLETE",
	summaryLine: "Implemented",
	errorOutput: "",
	textOnly: "IMPLEMENTATION_COMPLETE",
};

export const emptyFilteredData: FilteredIssueData = { body: "", comments: [] };
