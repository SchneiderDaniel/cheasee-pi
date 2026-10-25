import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";

import {
	createStageState,
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

describe("handlePostAgentSuccess — researcher budget exceeded", () => {
	const baseBudgetResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "researcher",
		toolCount: 15,
		tokenCount: 50000,
		durationMs: 45000,
		textOutput:
			'{"action":"ARCHITECTURE_COMPLETE","commentBody":"## Research Findings\\n- Finding 1\\n- Finding 2"}',
		summaryLine: "Research complete (budget exceeded)",
		errorOutput: "",
		textOnly:
			'{"action":"RESEARCH_COMPLETE","commentBody":"## Research Findings\\n- Finding 1\\n- Finding 2"}',
		budgetExceeded: true,
	};

	/**
	 * Custom pi mock that captures the comment body written to temp file.
	 * postIssueComment writes body to ignore/comment-body-*.md then calls gh --body-file.
	 * We intercept the gh call to read the body before the file is deleted.
	 */
	function createMockPiWithBodyCapture(capturedBodies: string[], calls: ExecCall[]): ExtensionAPI {
		let idx = 0;
		return {
			exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
				calls.push({ cmd, args: args || [], opts: opts || {} });
				// Intercept gh calls to capture body from --body-file before deletion
				if ((cmd === "gh" || cmd === "bash") && args.includes("--body-file")) {
					const bodyFileIdx = args.indexOf("--body-file");
					const bodyPath = args[bodyFileIdx + 1];
					if (bodyPath) {
						try {
							const body = readFileSync(bodyPath, "utf-8");
							capturedBodies.push(body);
						} catch {
							capturedBodies.push("");
						}
					}
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
			registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
			sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
		} as ExtensionAPI;
	}

	it("researcher + budgetExceeded + valid commentBody: posts combined stopped-early header + findings in single comment", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			budgetExceeded: true,
			textOutput: "COMMENT_BODY:\n## Research Findings\nFinding 1\nFinding 2\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nFinding 1\nFinding 2\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
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

		assert.equal(success, true, "pipeline should continue");

		// Single port.postIssueComment call — the combined message
		const commentCalls = trackCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(commentCalls.length, 1, "exactly one postIssueComment call (combined message)");

		// Verify body content from port call args
		const body = commentCalls[0]!.args[2] as string;
		assert.ok(
			body.includes("Research stopped early"),
			"body contains 'Research stopped early' header",
		);
		assert.ok(body.includes("50000"), "body contains tokenCount value");
		assert.ok(body.includes("Finding 1"), "body contains partial findings content");
	});

	it("researcher + budgetExceeded + valid commentBody: single postIssueComment call (no separate budget comment)", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			budgetExceeded: true,
			textOutput: "COMMENT_BODY:\n## Research Findings\nPartial data\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nPartial data\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
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

		assert.equal(success, true);

		const commentCalls = trackCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(
			commentCalls.length,
			1,
			"only one postIssueComment call — no separate budget-exceeded comment",
		);
	});

	it("researcher + budgetExceeded + no commentBody: graceful degradation comment posted (preserved behavior)", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			budgetExceeded: true,
			textOutput: "", // no commentBody
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
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

		assert.equal(success, true);

		const commentCalls = trackCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(commentCalls.length, 1, "graceful degradation comment posted");

		const body = commentCalls[0]!.args[2] as string;
		assert.ok(
			body.includes("No relevant results found"),
			"body contains graceful degradation message",
		);
	});

	it("researcher + budgetExceeded + comment post fails: returns true (advisory)", async () => {
		const port = createMockGitHubPort({
			postIssueComment: async () => {
				throw new Error("timeout");
			},
		});
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			budgetExceeded: true,
			textOutput: "COMMENT_BODY:\n## Research Findings\nData\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nData\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
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

		assert.equal(success, true, "comment failure is advisory — pipeline continues");
	});

	it("architect + budgetExceeded=true: no header prepended, normal architect comment posted", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			agentName: "architect",
			budgetExceeded: true,
			textOutput: "COMMENT_BODY:\n## Architecture\nDesign spec\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Architecture\nDesign spec\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
			ctx,
			result,
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

		assert.equal(success, true);

		const commentCalls = trackCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(commentCalls.length, 1, "architect comment posted");

		const body = commentCalls[0]!.args[2] as string;
		assert.ok(body.includes("## Architecture"), "architect heading preserved");
		assert.ok(
			!body.includes("Research stopped early"),
			"architect comment does NOT contain researcher stopped-early header",
		);
	});

	it("researcher + budgetExceeded=false: normal comment without stopped-early header", async () => {
		const trackCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, trackCalls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseBudgetResult,
			budgetExceeded: false, // happy path — no budget exceeded
			textOutput: "COMMENT_BODY:\n## Research Findings\nFull data\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nFull data\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			createMockPi([]),
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

		assert.equal(success, true);

		const commentCalls = trackCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(commentCalls.length, 1, "normal researcher comment posted");

		const body = commentCalls[0]!.args[2] as string;
		assert.ok(body.includes("## Research Findings"), "normal heading preserved");
		assert.ok(
			!body.includes("Research stopped early"),
			"no stopped-early header when budget not exceeded",
		);
	});
});
describe("createStageState()", () => {
	it("creates state with given initial status", () => {
		const state = createStageState("Architecture");
		assert.equal(state.loopStatus, "Architecture");
		assert.equal(state.lastAuditScore, null);
		assert.equal(state.auditCycleCount, 0);
	});

	it("creates state with 'Done' status", () => {
		const state = createStageState("Done");
		assert.equal(state.loopStatus, "Done");
	});

	it("initializes researcherSkipped to false", () => {
		const state = createStageState("Research");
		assert.equal(state.researcherSkipped, false);
	});

	it("initializes duplicateCodeResult to null", () => {
		const state = createStageState("Implementation");
		assert.equal(state.duplicateCodeResult, null);
	});
});
