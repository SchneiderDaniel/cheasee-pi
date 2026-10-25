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
	MAX_PIPELINE_LOOPS,
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
	it("developer with notify parameter — commitAndPush returns Result.ok=false on push failure, handlePostAgentSuccess returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
				{ code: 1, stdout: "", stderr: "push rejected" }, // git push fails
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

		// commitAndPush now returns Result<boolean> with ok=false on push failure
		// commitAndPush internally calls pushBranch which uses withNotify/notify.error
		// Then handlePostAgentSuccess sees !commitResult.ok and returns false
		assert.equal(success, false, "push failure should return false — pipeline stops");
	});
	it("gateRejected passed to auditor → posts gate rejection comment instead of approval", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "APPROVED",
				agentName: "auditor",
				commentBody: "## Audit Approved\nAll good",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };
		const gateRejected = {
			score: { passing: 4, total: 7 },
			required: 6,
			total: 7,
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
			gateRejected,
			undefined,
			port,
		);

		assert.equal(success, true, "gate rejection should still allow pipeline to continue");
		// Should call port.postIssueComment
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post gate rejection comment via port");
	});
	it("gateRejected with auditor REJECTED action → gate still posted (gate takes priority)", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "REJECTED",
				agentName: "auditor",
				commentBody: "## Audit Rejected\nBad code",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };
		const gateRejected = {
			score: { passing: 3, total: 8 },
			required: 6,
			total: 8,
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
			gateRejected,
			undefined,
			port,
		);

		assert.equal(success, true);
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post gate rejection comment via port");
	});
	it("no gateRejected + auditor APPROVED → normal approval comment posted", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "APPROVED",
				agentName: "auditor",
				commentBody: "## Audit Approved\nAll good",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

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

		assert.equal(success, true);
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post normal approval comment via port");
	});
	it("no gateRejected + auditor REJECTED → normal rejection comment posted", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const pi = createMockPi([]);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "REJECTED",
				agentName: "auditor",
				commentBody: "## Audit Rejected\nBad code",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

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

		assert.equal(success, true);
		const commentCall = trackCalls.find((c) => c.method === "postIssueComment");
		assert.ok(commentCall, "should post normal rejection comment via port");
	});
	describe("MAX_PIPELINE_LOOPS", () => {
		it("is a positive integer", () => {
			assert.equal(typeof MAX_PIPELINE_LOOPS, "number");
			assert.ok(MAX_PIPELINE_LOOPS > 0);
		});

		it("equals 20", () => {
			// Explicit value check — changing this has implications for loop limits
			assert.equal(MAX_PIPELINE_LOOPS, 20);
		});
	});
});
