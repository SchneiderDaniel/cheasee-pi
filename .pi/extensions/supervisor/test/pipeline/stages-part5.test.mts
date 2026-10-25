import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";

import {
	type StageState,
	type AuditGateContext,
	type GateRejected,
	handlePostAgentSuccess,
} from "../../pipeline/stages/index.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: {
				fg: (_style: string, text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;
}

const mockConfig: SupervisorConfig = {
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

function makeProjectFields(statusFieldId: string): ProjectField[] {
	return [
		{
			id: statusFieldId,
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt_bk", name: "Backlog" },
				{ id: "opt_re", name: "Research" },
				{ id: "opt_ar", name: "Architecture" },
				{ id: "opt_td", name: "TestDesign" },
				{ id: "opt_im", name: "Implementation" },
				{ id: "opt_au", name: "Audit" },
				{ id: "opt_dn", name: "Done" },
			],
		},
	];
}

function wrapJsonOutput(obj: Record<string, unknown>): string {
	return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

describe("handlePostAgentSuccess()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "architect",
		toolCount: 5,
		tokenCount: 2000,
		durationMs: 10000,
		textOutput: "COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END",
		summaryLine: "Wrote architecture",
		errorOutput: "",
		textOnly:
			"COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END\nARCHITECTURE_COMPLETE",
	};
	it("posts comment for architect when output contains COMMENT_BODY — returns true", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "architect comment post succeeds — pipeline should continue");
		// Should call port.postIssueComment
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should call port.postIssueComment for architect");
		assert.equal(commentCall!.args[0], 42, "should post to issue 42");
	});
	it("architect comment post fails (port error) — returns true (advisory), pipeline continues", async () => {
		const port = createMockGitHubPort({
			postIssueComment: async () => {
				throw new Error("network error");
			},
		});
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "architect comment failure is advisory — pipeline should continue");
	});
	it("posts comment for test-designer when output contains COMMENT_BODY — returns true", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "test-designer",
			textOutput: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END\nTEST_PLAN_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"test-designer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "test-designer success — pipeline should continue");
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should call port.postIssueComment for test-designer");
	});
	it("posts comment for researcher when output contains COMMENT_BODY — returns true", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "researcher success — pipeline should continue");
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should call port.postIssueComment for researcher");
	});
	it("researcher comment post fails (port error) — returns true (advisory), pipeline continues", async () => {
		const port = createMockGitHubPort({
			postIssueComment: async () => {
				throw new Error("timeout");
			},
		});
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(
			success,
			true,
			"researcher comment failure is advisory — pipeline should continue",
		);
	});
	it("commits and pushes for developer when worktreePath and branch provided — returns true", async () => {
		const calls: ExecCall[] = [];
		// developer commit+pull uses: commitAndPush which calls git add, commit, push
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "commit/push succeeds — pipeline should continue");
		// Should call git operations
		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.ok(gitCalls.length > 0, "should call git operations for developer");
	});
	it("developer git add fails (code 1) — returns false, signals critical failure", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "fatal: could not add" }, // git add fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git add failure must return false — pipeline should stop");
	});
	it("developer git commit fails with real error (not 'nothing to commit') — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A succeeds
				{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (changes staged → proceed to commit)
				{ code: 1, stdout: "", stderr: "fatal: bad object" }, // git commit fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git commit failure must return false — pipeline should stop");
	});
	it("developer git push fails (network error) — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 0, stdout: "", stderr: "" }, // git commit succeeds
				{ code: 1, stdout: "", stderr: "fatal: could not push" }, // git push fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git push failure must return false — pipeline should stop");
	});
});
