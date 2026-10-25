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
	it("timed-out first run → retry skipped, single FAILED entry with timedOut state", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-timeout-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Timed out",
				textOnly: "Timed out",
				timedOut: true,
				configuredTimeoutMs: 60_000,
				killReason: "timeout",
				durationMs: 60_000,
				errorOutput: "[Timeout: developer exceeded 60s (actual 60000ms)]",
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runner.mock.calls.length, 1, "timeout is NOT retried — hard 1× bound");
		assert.equal(runCtx.agentResults.length, 1, "single dispatch → single row");
		const entry = runCtx.agentResults[0]!;
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.timedOut, true, "timedOut recorded on pipeline state");
		assert.equal(entry.configuredTimeoutMs, 60_000, "configured duration recorded");
		assert.ok(
			(entry.errorOutput ?? "").includes("[Timeout: developer exceeded 60s"),
			"timeout failure note retained in errorOutput",
		);
	});
	it("timeout failure stops the pipeline with stopReason naming agent + duration", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-timeout-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Timed out",
				textOnly: "Timed out",
				timedOut: true,
				configuredTimeoutMs: 60_000,
				durationMs: 60_000,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.ok(
			runCtx.stopReason?.includes("timed out"),
			`stopReason names the timeout: ${runCtx.stopReason}`,
		);
		assert.ok(
			runCtx.stopReason?.includes("developer"),
			`stopReason names the agent: ${runCtx.stopReason}`,
		);
		assert.ok(
			runCtx.stopReason?.includes("configured 60s"),
			`stopReason carries the configured duration: ${runCtx.stopReason}`,
		);
	});
	it("researcher timeout does NOT take the budget-degradation continue path", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-timeout-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner(
			[
				{
					output: "raw",
					success: false,
					agentName: "researcher",
					toolCount: 0,
					tokenCount: 0,
					durationMs: 30_000,
					textOutput: "Research timed out",
					textOnly: "Research timed out",
					summaryLine: "Research timed out",
					errorOutput: "[Timeout: researcher exceeded 30s (actual 30000ms)]",
					timedOut: true,
					configuredTimeoutMs: 30_000,
					killReason: "timeout",
				},
			],
			"researcher",
		);

		const runCtx = buildRetryRunContext({
			runner,
			portCalls,
			tmpCwd,
			wt,
			loopStatus: "Research",
		});
		await runAgentLoop(runCtx);

		assert.equal(runCtx.agentResults.length, 1, "no retry for researcher timeout");
		assert.ok(
			runCtx.stopReason?.includes("timed out"),
			`researcher timeout stops the pipeline: ${runCtx.stopReason}`,
		);
		assert.ok(
			!portCalls.some((c) => c.method === "setItemStatusField"),
			"no Research → Architecture transition (budget path would have continued)",
		);
	});
	it("timed-out developer with a partial IMPLEMENTATION_COMPLETE marker still STOPS (audit #3)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-timeout-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		// success=false + timedOut + a forward marker in the partial output.
		// Before the fix, hadExplicitMarker=true let this bypass the Bug #711
		// failure guard and transition Implementation → Audit on partial work.
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				timedOut: true,
				configuredTimeoutMs: 60_000,
				killReason: "timeout",
				durationMs: 60_000,
				textOutput:
					"Implemented partially\nIMPLEMENTATION_COMPLETE\n(work incomplete — ran out of time)",
				textOnly: "IMPLEMENTATION_COMPLETE",
				errorOutput: "[Timeout: developer exceeded 60s (actual 60000ms)]",
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runner.mock.calls.length, 1, "single dispatch — no retry on timeout");
		assert.equal(runCtx.agentResults.length, 1);
		assert.equal(runCtx.agentResults[0]?.status, "FAILED");
		assert.ok(
			runCtx.stopReason?.includes("timed out"),
			`stopReason names the timeout, not a transition: ${runCtx.stopReason}`,
		);
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"NO Implementation → Audit transition despite the forward marker (unconditional stop)",
		);
	});
});
