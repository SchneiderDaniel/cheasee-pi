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
	it("posts exactly one refusal comment and stops without a status transition", async () => {
		const { runCtx, portCalls } = runRefusal({
			refusalJson: JSON.stringify({
				action: "COMPLETE",
				agentName: "architect",
				refusal: "cannot design this reliably",
				commentBody: "## Refusal\n\nOut of scope for this issue.",
			}),
		});
		await runAgentLoop(runCtx);

		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1, `exactly one comment, got: ${JSON.stringify(comments)}`);
		assert.ok(comments[0].includes("Out of scope"), "agent-supplied commentBody posted");
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no status transition on refusal",
		);
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason, got: ${runCtx.stopReason}`,
		);
		assert.ok(runCtx.stopReason?.includes("cannot design this reliably"));
		assert.equal(runCtx.loopStatus, "Architecture", "loopStatus unchanged");
	});
	it("posts non-blank refusal commentBody verbatim (surrounding whitespace preserved)", async () => {
		// Regression (audit fix): trim must be for blank detection only — the
		// agent's markdown (leading/trailing whitespace) is posted untouched.
		const body = "  ## Why\n\nDetails  ";
		const { runCtx, portCalls } = runRefusal({
			refusalJson: JSON.stringify({ refusal: "whitespace case", commentBody: body }),
		});
		await runAgentLoop(runCtx);

		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1, "exactly one comment");
		assert.equal(comments[0], body, "non-blank commentBody posted verbatim, not trimmed");
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason, got: ${runCtx.stopReason}`,
		);
	});
	it("falls back to a generated note when commentBody is missing", async () => {
		const { runCtx, portCalls } = runRefusal({
			refusalJson: JSON.stringify({ refusal: "missing dependency", agentName: "architect" }),
		});
		await runAgentLoop(runCtx);
		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1);
		assert.ok(comments[0].includes("Agent Refused"), "generated note header");
		assert.ok(comments[0].includes("missing dependency"), "reason surfaced");
		assert.equal(portCalls.filter((c) => c.method === "setItemStatusField").length, 0);
	});
	it("falls back to a generated note when commentBody is blank/whitespace-only", async () => {
		for (const blank of ["", "   \n\t "]) {
			const { runCtx, portCalls } = runRefusal({
				refusalJson: JSON.stringify({ refusal: "blank body case", commentBody: blank }),
			});
			await runAgentLoop(runCtx);
			const comments = commentsOf(portCalls);
			assert.equal(comments.length, 1, `blank=${JSON.stringify(blank)} → exactly one comment`);
			assert.ok(
				comments[0].trim().length > 0,
				`blank=${JSON.stringify(blank)} → comment is not empty`,
			);
			assert.ok(
				comments[0].includes("blank body case"),
				`blank=${JSON.stringify(blank)} → reason surfaced instead of blank body`,
			);
		}
	});
	it("success:false + refusal JSON (no budgetExceeded) → no retry, refusal note, stop", async () => {
		// Regression (audit finding #7): dispatchAgentWithRetry used to retry
		// any success=false result before the handler parsed the refusal, so a
		// valid refusal on a failed run could be replaced by the retry attempt
		// — advancing the pipeline or producing a different stop outcome. A
		// refusal is the definitive outcome: the runner must be invoked once,
		// the refusal note posted, and the pipeline stopped.
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
		const refusalJson = JSON.stringify({ refusal: "cannot continue", agentName: "architect" });
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "architect") {
				return makeDevResult({
					agentName: "architect",
					success: false,
					budgetExceeded: false,
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

		assert.equal(runner.mock.callCount(), 1, "no retry when the initial result is a refusal");
		const comments = commentsOf(portCalls);
		assert.equal(
			comments.length,
			1,
			`exactly one refusal comment, got: ${JSON.stringify(comments)}`,
		);
		assert.ok(comments[0].includes("Agent Refused"), "generated refusal note posted");
		assert.ok(comments[0].includes("cannot continue"), "refusal reason surfaced");
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no status transition on refusal",
		);
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason, got: ${runCtx.stopReason}`,
		);
		assert.equal(runCtx.loopStatus, "Architecture", "loopStatus unchanged");
	});
	it("auditor refusal posts one refusal note — no false audit verdict, no transition", async () => {
		// Regression (audit finding): `action: "REJECTED"` + `refusal` used to
		// reach handleAuditorOutput before the refusal branch, whose bare-text
		// fallback matched \bRejected\b and posted a bogus audit verdict comment
		// in addition to the refusal note.
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
			action: "REJECTED",
			agentName: "auditor",
			refusal: "cannot review this task",
		});
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0]?.agent as { config?: { name?: string } };
			if (agent?.config?.name === "auditor") {
				return makeDevResult({
					agentName: "auditor",
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
			loopStatus: "Audit",
			worktreePath: undefined,
		});
		await runAgentLoop(runCtx);

		const comments = commentsOf(portCalls);
		assert.equal(comments.length, 1, `exactly one comment, got: ${JSON.stringify(comments)}`);
		assert.ok(
			!comments[0].includes("## Audit Rejected") && !comments[0].includes("## Audit Approved"),
			"refusal must not be posted as an audit verdict",
		);
		assert.ok(comments[0].includes("cannot review this task"), "refusal reason surfaced");
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"no status transition on auditor refusal",
		);
		assert.ok(
			runCtx.stopReason?.includes("Agent refused"),
			`stopReason, got: ${runCtx.stopReason}`,
		);
	});
});
