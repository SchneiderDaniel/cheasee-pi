import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunResult, SupervisorConfig } from "../../config/types.ts";

import type { RunContext } from "../../pipeline/handler/shared.ts";

import type { PortCall } from "../helper/mock-github-port.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";

import { createStageState } from "../../pipeline/stages/index.ts";

import { ErrorCollector } from "../../pipeline/error-collector.ts";

import { mkdtempSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

type GitReply = { code: number; stdout?: string; stderr?: string } | null;

function createMockPi(calls?: ExecCall[], gitHandler?: (args: string[]) => GitReply): ExtensionAPI {
	const callLog = calls || [];
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const r = gitHandler?.(args || []) ?? null;
			return Promise.resolve({
				code: r?.code ?? 0,
				stdout: r?.stdout ?? "",
				stderr: r?.stderr ?? "",
			});
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(notifyLog?: Array<{ msg: string; type: string }>): ExtensionCommandContext {
	const log = notifyLog || [];
	return {
		cwd: "/repo",
		ui: {
			notify: (msg: string, type?: string) => {
				log.push({ msg, type: type || "info" });
			},
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

const SUMMARY_CONFIG: SupervisorConfig = {
	...mockConfig,
	statusMapping: { todo: "developer" },
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

function createQueueRunner(results: AgentRunResult[], agentName = "developer") {
	return mock.fn(async (...args: any[]) => {
		const next = results.shift();
		if (!next) {
			return makeDevResult({
				success: false,
				errorOutput: "unexpected extra dispatch in retry test",
			});
		}
		const agent = args[0]?.agent as { config?: { name?: string } };
		if (agent?.config?.name !== agentName) {
			return makeDevResult({
				success: false,
				errorOutput: `unexpected agent dispatch: ${agent?.config?.name}`,
			});
		}
		return next;
	});
}

function makeAuditResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "auditor",
		toolCount: 3,
		tokenCount: 500,
		durationMs: 5000,
		textOutput: "Audited\nAUDIT_DECISION: REJECTED",
		textOnly: "AUDIT_DECISION: REJECTED",
		summaryLine: "Audited",
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

function buildRetryRunContext(opts: {
	runner: ReturnType<typeof mock.fn>;
	portCalls: PortCall[];
	tmpCwd: string;
	wt: string;
	comments?: Array<{ author?: { login?: string }; body?: string | null }>;
	loopStatus?: string;
	notifyLog?: Array<{ msg: string; type: string }>;
	config?: Partial<SupervisorConfig>;
	gitHandler?: (args: string[]) => GitReply;
}): RunContext {
	const execCalls: ExecCall[] = [];
	const pi = createMockPi(execCalls, opts.gitHandler);
	const ctx = createMockCtx(opts.notifyLog);
	const ctxWithCwd = { ...ctx, cwd: opts.tmpCwd } as unknown as ExtensionCommandContext;

	const port = createMockGitHubPort(
		{
			getClosingPrsForIssue: async () => [],
			postIssueComment: async () => {},
			closeIssue: async () => {},
			setItemStatusField: async () => {},
			listComments: async () =>
				(opts.comments ?? []).map((c) => ({
					author: c.author?.login ? { login: c.author.login } : undefined,
					body: c.body ?? undefined,
				})),
			getAuthenticatedLogin: async () => "user1",
		},
		opts.portCalls,
	);

	return {
		args: undefined,
		ctx: ctxWithCwd,
		pi,
		issueNum: 1494,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 1494,
						title: "Test issue",
						body: "body",
						author: { login: "user1" },
						comments: opts.comments ?? [],
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: { ...mockConfig, ...opts.config } as any,
		port,
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: {
			number: 1494,
			title: "Test issue",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: createStageState(opts.loopStatus || "Implementation"),
		loopStatus: opts.loopStatus || "Implementation",
		loopItem: { id: "item-1" },
		fields: FIELDS as any,
		statusField: FIELDS[0] as any,
		projectId: "project-1",
		worktreePath: opts.wt,
		worktreeBranch: "worktree-git-issue-1494-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

const TEST_PLAN_QUOTE =
	'## Test Plan\n\nno "## Audit Rejected"/"## Audit Approved" verdict comment';

function trustedComment(body: string): { author: { login: string }; body: string } {
	// Genuine rejections are authored by the automation account (the port's
	// getAuthenticatedLogin returns "user1" in this harness), so the pipeline
	// treats them as its own output (issue #2044); quoted Test Plan text does
	// not start with the heading and is never selected.
	return { author: { login: "user1" }, body };
}

function makeRejectWorktree(): string {
	return mkdtempSync(join(tmpdir(), "agent-loop-reject-wt-"));
}

async function runLoopWithComments(opts: {
	comments: Array<{ author?: { login?: string }; body?: string | null }>;
	loopStatus: string;
	queue: AgentRunResult[];
	queueAgent: string;
}): Promise<{
	runCtx: RunContext;
	runner: ReturnType<typeof mock.fn>;
	notifyLog: Array<{ msg: string; type: string }>;
}> {
	const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-reject-cwd-"));
	const wt = makeRejectWorktree();
	const portCalls: PortCall[] = [];
	const notifyLog: Array<{ msg: string; type: string }> = [];
	const runner = createQueueRunner(opts.queue, opts.queueAgent);
	const runCtx = buildRetryRunContext({
		runner,
		portCalls,
		tmpCwd,
		wt,
		comments: opts.comments,
		loopStatus: opts.loopStatus,
		notifyLog,
	});
	await runAgentLoop(runCtx);
	return { runCtx, runner, notifyLog };
}

const LARGE_TEST_PLAN = "## Test Plan\n**Tier:** Large";

function timedOutDevResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return makeDevResult({
		success: false,
		textOutput: "Timed out",
		textOnly: "Timed out",
		timedOut: true,
		killReason: "timeout",
		durationMs: 3_600_000,
		configuredTimeoutMs: 3_600_000,
		errorOutput: "[Timeout: developer exceeded 3600s]",
		...overrides,
	});
}

function runDeveloper(opts: {
	comments?: Array<{ author?: { login?: string }; body?: string | null }>;
	config?: Partial<SupervisorConfig>;
	queue?: AgentRunResult[];
	loopStatus?: string;
	queueAgent?: string;
	gitHandler?: (args: string[]) => GitReply;
}): { runner: ReturnType<typeof mock.fn>; runCtx: RunContext } {
	const runner = createQueueRunner(
		opts.queue ?? [makeDevResult({})],
		opts.queueAgent ?? "developer",
	);
	const runCtx = buildRetryRunContext({
		runner,
		portCalls: [],
		tmpCwd: mkdtempSync(join(tmpdir(), "agent-loop-tier-cwd-")),
		wt: mkdtempSync(join(tmpdir(), "agent-loop-tier-wt-")),
		comments: opts.comments,
		loopStatus: opts.loopStatus,
		config: opts.config,
		gitHandler: opts.gitHandler,
	});
	return { runner, runCtx };
}

describe("runAgentLoop — per-agent wall-clock timeout (issue #1710)", () => {
	function makeWorktree(): string {
		return mkdtempSync(join(tmpdir(), "agent-loop-timeout-wt-"));
	}
	it("timed-out auditor with an approval marker still STOPS — no Done transition (audit #3)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-timeout-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		// success=false + timedOut + a partial approval marker. Before the
		// fix the explicit-marker guard let this advance towards Done / PR
		// creation on partial audit output.
		const runner = createQueueRunner(
			[
				makeAuditResult({
					success: false,
					timedOut: true,
					configuredTimeoutMs: 60_000,
					killReason: "timeout",
					durationMs: 60_000,
					textOutput: "AUDIT_DECISION: APPROVED\n(partial audit — timed out before completion)",
					textOnly: "AUDIT_DECISION: APPROVED",
					errorOutput: "[Timeout: auditor exceeded 60s (actual 60000ms)]",
				}),
			],
			"auditor",
		);

		const runCtx = buildRetryRunContext({
			runner,
			portCalls,
			tmpCwd,
			wt,
			loopStatus: "Audit",
		});
		await runAgentLoop(runCtx);

		assert.equal(runner.mock.calls.length, 1, "single dispatch — no retry on timeout");
		assert.ok(
			runCtx.stopReason?.includes("timed out"),
			`stopReason names the timeout: ${runCtx.stopReason}`,
		);
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"NO Audit → Done transition despite the approval marker (unconditional stop)",
		);
		assert.equal(
			portCalls.filter((c) => c.method === "postIssueComment").length,
			0,
			"no approval/verdict comment posted on a timed-out audit",
		);
	});
});
describe("runAgentLoop — rejection-limit gate (issue #1668)", () => {
	it("4 genuine rejections + 1 quoted Test Plan, max 5 → gate does NOT trip, auditor dispatched", async () => {
		const comments = [
			trustedComment("## Audit Rejected\nFirst"),
			trustedComment("## Audit Rejected\nSecond"),
			trustedComment("## Audit Rejected\nThird"),
			trustedComment(TEST_PLAN_QUOTE),
			trustedComment("## Audit Rejected\nFourth"),
		];
		const { runCtx, runner, notifyLog } = await runLoopWithComments({
			comments,
			loopStatus: "Audit",
			queue: [makeAuditResult({})],
			queueAgent: "auditor",
		});

		assert.ok(runner.mock.calls.length >= 1, "auditor was dispatched — gate did not trip");
		const firstAgent = (runner.mock.calls[0]!.arguments[0] as any)?.agent?.config?.name;
		assert.equal(firstAgent, "auditor", "first dispatch is the auditor, not a hard stop");
		assert.equal(
			runCtx.agentResults[0]?.agentName,
			"auditor",
			"auditor run recorded — loop advanced past the Audit step",
		);
		assert.ok(
			!runCtx.stopReason?.includes("Rejection limit"),
			`quoted Test Plan must not trip the limit, got: ${runCtx.stopReason}`,
		);
		assert.ok(
			notifyLog.every((n) => !n.msg.includes("rejected 5 times")),
			"no rejection-limit notify fired",
		);
	});

	it("5 genuine rejections, max 5 → hard stop BEFORE any dispatch, stopReason + notify use count", async () => {
		const comments = Array.from({ length: 5 }, (_, i) =>
			trustedComment(`## Audit Rejected\nIssue ${i + 1}`),
		);
		const { runCtx, runner, notifyLog } = await runLoopWithComments({
			comments,
			loopStatus: "Audit",
			queue: [makeAuditResult({})],
			queueAgent: "auditor",
		});

		assert.equal(runner.mock.calls.length, 0, "no dispatch before the hard stop");
		assert.equal(runCtx.stopReason, "Rejection limit reached (5)");
		assert.ok(
			notifyLog.some(
				(n) => n.msg.includes("rejected 5 times") && n.msg.includes("Human intervention required"),
			),
			"operator notify reports the actual rejection count",
		);
	});

	it("7 genuine rejections, max 5 → reports the actual count (7), not the threshold", async () => {
		const comments = Array.from({ length: 7 }, (_, i) =>
			trustedComment(`## Audit Rejected\nIssue ${i + 1}`),
		);
		const { runCtx, notifyLog } = await runLoopWithComments({
			comments,
			loopStatus: "Audit",
			queue: [makeAuditResult({})],
			queueAgent: "auditor",
		});

		assert.equal(runCtx.stopReason, "Rejection limit reached (7)");
		assert.ok(
			notifyLog.some((n) => n.msg.includes("rejected 7 times")),
			"notify reports 7 (count), not 5 (threshold)",
		);
	});

	it("mid-body quote only, max 5 → not counted, auditor dispatched", async () => {
		const comments = [trustedComment("intro\n\n## Audit Rejected\n...")];
		const { runCtx, runner } = await runLoopWithComments({
			comments,
			loopStatus: "Audit",
			queue: [makeAuditResult({})],
			queueAgent: "auditor",
		});

		assert.ok(runner.mock.calls.length >= 1, "mid-body quote is not a rejection");
		assert.ok(!runCtx.stopReason?.includes("Rejection limit"));
	});
});
