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
	it("developer commit returns 'nothing to commit' — returns true (still pushes, branch may not exist on remote)", async () => {
		const calls: ExecCall[] = [];
		// commitAndPush now has a pre-commit git diff --cached --quiet check.
		// When code=0 (nothing staged), commit is skipped and we proceed to push.
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 0, stdout: "", stderr: "" }, // git diff --cached --quiet (nothing staged → skip commit)
				{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push succeeds
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

		assert.equal(success, true, "'nothing to commit' returns silently — pipeline continues");
		// Flow: add, diff(cached --quiet code=0 → skip commit), push
		assert.equal(calls.length, 3, "should call add + diff + push");
		// Verify push was called (fix #595: branch may not exist on remote yet)
		const pushCall = calls.find((c) => c.cmd === "git" && c.args[0] === "push");
		assert.ok(pushCall, "should have a git push call");
		// Verify diff --cached was called (pre-commit emptiness check, code=0 → skip commit)
		const diffCachedCall = calls.find(
			(c) => c.cmd === "git" && c.args.includes("diff") && c.args.includes("--cached"),
		);
		assert.ok(diffCachedCall, "should have git diff --cached --quiet call");
	});
	it("developer with worktreePath undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
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
			undefined,
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "no worktreePath — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});
	it("developer with worktreeBranch undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
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
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "no worktreeBranch — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});
	it("handles auditor approval output with structured AUDIT_DECISION — returns true", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
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

		assert.equal(success, true, "auditor — pipeline should continue");
		// Should call port.postIssueComment
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post audit approval comment via port");
	});
	it("handles auditor rejection output — returns true", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
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

		assert.equal(success, true, "auditor — pipeline should continue");
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post audit rejection comment via port");
	});
	it("handles auditor output with no COMMENT_BODY marker and no JSON — no comment posted, pipeline continues", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
			textOnly: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
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

		assert.equal(success, true, "auditor — pipeline should continue");
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.equal(
			commentCall,
			undefined,
			"no comment posted when output has no JSON and no COMMENT_BODY marker",
		);
	});
	it("does not post comment for developer (no comment body extraction needed)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
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
			undefined,
			undefined,
			"Test issue",
		);

		// No gh calls expected for developer without worktree
		assert.equal(success, true, "no worktree — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});
	it("developer with notify parameter — commitAndPush success returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
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

		// Provide a notify function and verify it's used correctly
		const notifyCalls: Array<{ level: string; msg: string }> = [];
		const notify = {
			info: (msg: string) => notifyCalls.push({ level: "info", msg }),
			error: (msg: string) => notifyCalls.push({ level: "error", msg }),
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
			undefined, // collector
			undefined, // gateRejected
			notify, // notify
		);

		assert.equal(success, true, "commit/push with notify should succeed");
		// notify.error should NOT be called on success
		assert.equal(notifyCalls.filter((c) => c.level === "error").length, 0);
		// git calls: add + commit + push
		assert.ok(calls.length >= 3);
	});
});
