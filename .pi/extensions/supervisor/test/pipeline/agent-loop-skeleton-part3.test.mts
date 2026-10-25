import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunResult, SupervisorConfig } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import type { PortCall } from "../helper/mock-github-port.ts";

import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";

import { createStageState } from "../../pipeline/stages/index.ts";

import type { RunContext } from "../../pipeline/handler/shared.ts";

import { ErrorCollector } from "../../pipeline/error-collector.ts";

import { mkdtempSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

function createMockPi(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
): ExtensionAPI {
	return {
		exec: execFn as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(notify: ReturnType<typeof mock.fn>): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: notify as unknown as ExtensionCommandContext["ui"]["notify"],
			setStatus: () => {},
			setWidget: mock.fn(),
			confirm: async () => true,
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
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 0,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
	agentTimeoutsMin: {},
};

function makeDevResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "developer",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: "Implemented\nIMPLEMENTATION_COMPLETE",
		textOnly: "IMPLEMENTATION_COMPLETE",
		summaryLine: "Implemented feature",
		errorOutput: "",
		...overrides,
	};
}

const FIELDS: Array<{
	id: string;
	name: string;
	type: string;
	options: Array<{ id: string; name: string }>;
}> = [
	{
		id: "status-field-id",
		name: "Status",
		type: "single_select",
		options: [
			{ id: "opt-backlog", name: "Backlog" },
			{ id: "opt-research", name: "Research" },
			{ id: "opt-architecture", name: "Architecture" },
			{ id: "opt-test-design", name: "TestDesign" },
			{ id: "opt-implementation", name: "Implementation" },
			{ id: "opt-audit", name: "Audit" },
			{ id: "opt-done", name: "Done" },
		],
	},
];

function buildRunContext(opts: {
	runner: ReturnType<typeof mock.fn>;
	port: GitHubPort;
	pi: ExtensionAPI;
	notify: ReturnType<typeof mock.fn>;
	loopStatus: string;
	worktreePath: string | undefined;
}): RunContext {
	return {
		args: undefined,
		ctx: createMockCtx(opts.notify),
		pi: opts.pi,
		issueNum: 1533,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 1533,
						title: "Test issue",
						body: "body",
						author: { login: "user1" },
						comments: [],
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: mockConfig as any,
		port: opts.port,
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: {
			number: 1533,
			title: "Test issue",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: createStageState(opts.loopStatus),
		loopStatus: opts.loopStatus,
		loopItem: { id: "item-1" },
		fields: FIELDS as any,
		statusField: FIELDS[0] as any,
		projectId: "project-1",
		worktreePath: opts.worktreePath,
		worktreeBranch: opts.worktreePath ? "worktree-git-issue-1533-test" : undefined,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

function emptyWorktreePi(opts: { revList?: string; logSha?: string }): ExtensionAPI {
	return createMockPi(async (cmd, args) => {
		if (cmd === "git" && args[0] === "rev-list")
			return { code: 0, stdout: opts.revList ?? "0", stderr: "" };
		if (cmd === "git" && args[0] === "log")
			return { code: 0, stdout: opts.logSha ?? "abc123", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
}

const WT = mkdtempSync(join(tmpdir(), "skeleton-wt-"));

describe("runAgentLoop skeleton — refusal handling (issue #1618)", () => {
	function runRefusal(opts: { refusalJson: string }): {
		runCtx: RunContext;
		portCalls: PortCall[];
		notify: ReturnType<typeof mock.fn>;
	} {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
				getClosingPrsForIssue: async () => [],
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({});
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "architect") {
				return makeDevResult({
					agentName: "architect",
					success: true,
					textOutput: opts.refusalJson,
					textOnly: opts.refusalJson,
				});
			}
			return makeDevResult({ success: false, errorOutput: "unexpected agent" });
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Architecture",
			worktreePath: undefined,
		});
		return { runCtx, portCalls, notify };
	}
	const commentsOf = (portCalls: PortCall[]): string[] =>
		portCalls.filter((c) => c.method === "postIssueComment").map((c) => c.args[2] as string);
	it("researcher refusal with budgetExceeded → refusal note posted, no degradation, no Research→Architecture transition", async () => {
		// Regression (audit finding): a refusal on a budget-exceeded run used to
		// be invisible (refusal detection was gated on result.success, which is
		// false when budgetExceeded), so handleBudgetExceeded ran first — posting
		// the degradation notice, transitioning Research → Architecture and
		// continuing the loop, never reaching the refusal branch. Refusal must
		// override budget degradation: one refusal comment, no transition, stop.
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
				getClosingPrsForIssue: async () => [],
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({});
		const refusalJson = JSON.stringify({
			refusal: "cannot research this issue",
			agentName: "researcher",
		});
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "researcher") {
				return makeDevResult({
					agentName: "researcher",
					success: false,
					budgetExceeded: true,
					tokenCount: 50_000,
					toolCount: 200,
					textOutput: refusalJson,
					textOnly: refusalJson,
				});
			}
			return makeDevResult({ success: false, errorOutput: "unexpected agent" });
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Research",
			worktreePath: undefined,
		});
		await runAgentLoop(runCtx);

		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1, `exactly one comment, got: ${JSON.stringify(comments)}`);
		assert.ok(comments[0].includes("Agent Refused"), "generated refusal note posted");
		assert.ok(comments[0].includes("cannot research this issue"), "refusal reason surfaced");
		assert.ok(
			!comments[0].includes("Research stopped early"),
			"no budget-degradation notice on a refusal",
		);
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no Research→Architecture transition on refusal",
		);
		assert.equal(runCtx.loopStatus, "Research", "loopStatus unchanged");
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason, got: ${runCtx.stopReason}`,
		);
	});
	it("developer refusal → no commit/post-success side effects, one refusal comment, stop", async () => {
		// Developer's post-success path (agent comment + commitAndPush) must be
		// skipped entirely on a refusal; the worktree is real, so if
		// handlePostAgentSuccess ran and commitAndPush failed, stopReason would
		// be "commitAndPush failed" — the refusal stop assertion catches that.
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
				getClosingPrsForIssue: async () => [],
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({});
		const refusalJson = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			refusal: "cannot implement this safely",
		});
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "developer") {
				return makeDevResult({
					agentName: "developer",
					success: true,
					textOutput: refusalJson,
					textOnly: refusalJson,
				});
			}
			return makeDevResult({ success: false, errorOutput: "unexpected agent" });
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Implementation",
			worktreePath: WT,
		});
		await runAgentLoop(runCtx);

		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1, `exactly one comment, got: ${JSON.stringify(comments)}`);
		assert.ok(comments[0].includes("cannot implement this safely"), "refusal reason surfaced");
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no status transition on developer refusal",
		);
		assert.ok(!portCalls.some((c) => c.method === "closeIssue"), "issue not closed");
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason must be the refusal stop (not a post-success failure), got: ${runCtx.stopReason}`,
		);
		assert.equal(runCtx.loopStatus, "Implementation", "loopStatus unchanged");
	});
	it("postIssueComment throws on refusal → collector warn, pipeline still stops with refusal stopReason", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {
					throw new Error("API down");
				},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
				getClosingPrsForIssue: async () => [],
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({});
		const refusalJson = JSON.stringify({ refusal: "cannot continue" });
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "architect") {
				return makeDevResult({
					agentName: "architect",
					success: true,
					textOutput: refusalJson,
					textOnly: refusalJson,
				});
			}
			return makeDevResult({ success: false, errorOutput: "unexpected agent" });
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Architecture",
			worktreePath: undefined,
		});
		await runAgentLoop(runCtx);

		// Comment posting failed — but the pipeline must still stop as a refusal
		// (no unhandled rejection, no bogus status transition).
		const warns = runCtx.collector.flush("handler");
		assert.ok(
			warns.some(
				(w) => w.severity === "warn" && w.message.includes("Failed to post refusal comment"),
			),
			`collector must carry the posting failure, got: ${JSON.stringify(warns)}`,
		);
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no status transition when refusal comment posting fails",
		);
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`pipeline still stops with refusal stopReason, got: ${runCtx.stopReason}`,
		);
	});
});
describe("runAgentLoop skeleton — full transition sequence + explicit-marker stop (issue #1533)", () => {
	it("Backlog→Research→Architecture→TestDesign→Implementation, then dev crash → 2 FAILED rows, explicit-marker stop", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
				getClosingPrsForIssue: async () => [],
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({});
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			switch (agent?.config?.name) {
				case "researcher":
					return makeDevResult({
						agentName: "researcher",
						textOutput: "Research\nRESEARCH_COMPLETE",
						textOnly: "RESEARCH_COMPLETE",
					});
				case "architect":
					return makeDevResult({
						agentName: "architect",
						textOutput: "Arch\nARCHITECTURE_COMPLETE",
						textOnly: "ARCHITECTURE_COMPLETE",
					});
				case "test-designer":
					return makeDevResult({
						agentName: "test-designer",
						textOutput: "Plan\nTEST_PLAN_COMPLETE",
						textOnly: "TEST_PLAN_COMPLETE",
					});
				case "developer":
					// crash: 0 tokens, 0 tools, no marker
					return makeDevResult({
						success: false,
						durationMs: 100,
						tokenCount: 0,
						toolCount: 0,
						textOutput: "crashed",
						textOnly: "crashed",
					});
				default:
					return makeDevResult({ success: false, errorOutput: "unexpected agent" });
			}
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Backlog",
			worktreePath: WT,
		});
		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.deepEqual(
			transitions,
			["opt-research", "opt-architecture", "opt-test-design", "opt-implementation"],
			"full forward transition sequence through the skeleton",
		);
		assert.ok(
			runCtx.stopReason?.includes("no explicit completion marker"),
			`dev crash stops with explicit-marker reason, got: ${runCtx.stopReason}`,
		);
		assert.equal(runCtx.loopStatus, "Implementation", "loopStatus write-back after stop");
		const devRows = runCtx.agentResults.filter((a) => a.agentName === "developer");
		assert.equal(devRows.length, 2, "dev crash → 2 FAILED rows (initial + retry)");
		for (const row of devRows) assert.equal(row.status, "FAILED");
	});
});
