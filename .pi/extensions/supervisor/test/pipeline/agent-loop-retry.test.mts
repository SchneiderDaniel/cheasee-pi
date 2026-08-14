// ─── Tests: runAgentLoop retry path — one PipelineAgentResult per dispatch ───
// Issue #1495: when an agent's first run fails and the in-iteration retry
// succeeds, the overview table must document BOTH runs. The retry block
// pushes the validated failed initial run (FAILED row) plus the retry run
// (SUCCESS (after retry) row) instead of overwriting the result.
//
// Harness runs the real runAgentLoop with an injected mock agent runner
// (RunContext._runner, pattern from handler.test.mts Phase 3) so no
// subprocess is spawned. Loop starts at Implementation (developer dispatch).

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
import { buildPipelineSummary } from "../../pipeline/output.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock helpers (mirror handler.test.mts Phase 3) ──────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(calls?: ExecCall[]): ExtensionAPI {
	const callLog = calls || [];
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve({ code: 0, stdout: "", stderr: "" });
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

// ─── Developer result factory ─────────────────────────────────────

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

// Serves a fixed queue of results, one per dispatch. Any unexpected extra
// dispatch (past the queue) fails hard so the test notices.
function createQueueRunner(results: AgentRunResult[]) {
	return mock.fn(async (...args: any[]) => {
		const next = results.shift();
		if (!next) {
			return makeDevResult({
				success: false,
				errorOutput: "unexpected extra dispatch in retry test",
			});
		}
		const agent = args[0] as { config?: { name?: string } };
		if (agent?.config?.name !== "developer") {
			return makeDevResult({
				success: false,
				errorOutput: `unexpected agent dispatch: ${agent?.config?.name}`,
			});
		}
		return next;
	});
}

// ─── RunContext builder ───────────────────────────────────────────

const FIELDS: Array<{ id: string; name: string; type: string; options: Array<{ id: string; name: string }> }> = [
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
}): RunContext {
	const execCalls: ExecCall[] = [];
	const pi = createMockPi(execCalls);
	const ctx = createMockCtx();
	const ctxWithCwd = { ...ctx, cwd: opts.tmpCwd } as unknown as ExtensionCommandContext;

	const port = createMockGitHubPort(
		{
			getClosingPrsForIssue: async () => [],
			postIssueComment: async () => {},
			closeIssue: async () => {},
			setItemStatusField: async () => {},
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
		stageState: createStageState("Implementation"),
		loopStatus: "Implementation",
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

// ─── Tests ────────────────────────────────────────────────────────

describe("runAgentLoop — retry path documents every dispatch (issue #1495)", () => {
	function makeWorktree(): string {
		return mkdtempSync(join(tmpdir(), "agent-loop-retry-wt-"));
	}

	it("fail-then-success: FAILED row (first stats) + SUCCESS (after retry) row (retry stats)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		// Issue #1494 real data: failed run 30m 0s, retry 17m 49s.
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Failed to implement",
				textOnly: "Failed to implement",
				durationMs: 1_800_025,
				tokenCount: 80_000,
				toolCount: 100,
				errorOutput: "bash exited 1: test command not found",
			}),
			makeDevResult({
				success: true,
				durationMs: 1_068_861,
				tokenCount: 60_000,
				toolCount: 80,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		// Exactly 2 developer entries — no stat overwrite.
		assert.equal(runCtx.agentResults.length, 2, "two dispatches → two rows");
		const [failed, retried] = runCtx.agentResults;

		assert.equal(failed.agentName, "developer");
		assert.equal(failed.status, "FAILED");
		assert.equal(failed.durationMs, 1_800_025, "failed row carries first run's duration");
		assert.equal(failed.tokenCount, 80_000, "failed row carries first run's tokens");
		assert.equal(failed.toolCount, 100, "failed row carries first run's tool calls");
		assert.ok(failed.errorOutput?.includes("bash exited 1"), "failed row carries errorOutput");

		assert.equal(retried.agentName, "developer");
		assert.equal(retried.status, "SUCCESS (after retry)");
		assert.equal(retried.durationMs, 1_068_861, "retry row carries retry run's duration");
		assert.equal(retried.tokenCount, 60_000);
		assert.equal(retried.toolCount, 80);
	});

	it("issue #1494 data renders both rows + totals include the failed run", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Failed to implement",
				textOnly: "Failed to implement",
				durationMs: 1_800_025,
				tokenCount: 80_000,
				toolCount: 100,
				errorOutput: "bash exited 1",
			}),
			makeDevResult({
				success: true,
				durationMs: 1_068_861,
				tokenCount: 60_000,
				toolCount: 80,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		const summary = buildPipelineSummary(
			runCtx.agentResults,
			"stopped",
			1494,
			"Test issue",
			SUMMARY_CONFIG,
		);
		const devRows = summary.split("\n").filter((l) => l.startsWith("| developer |"));
		assert.equal(devRows.length, 2, "both developer runs appear in the table");
		assert.ok(devRows[0].includes("✗ FAILED"), "first row is the failed run");
		assert.ok(devRows[0].includes("30m 0s"), "failed run duration 30m 0s");
		assert.ok(devRows[0].includes("80.0K"), "failed run tokens");
		assert.ok(devRows[0].includes("100"), "failed run tool count");
		assert.ok(devRows[1].includes("✓ SUCCESS (after retry)"), "second row is the retry run");
		assert.ok(devRows[1].includes("17m 49s"), "retry run duration 17m 49s");
		assert.ok(devRows[1].includes("60.0K"), "retry run tokens");
		// Totals = 1_800_025 + 1_068_861 = 2_868_886 ms = 47m 49s; 140.0K tokens; 180 tools.
		assert.ok(
			summary.includes("**Total:** 2 runs · 47m 49s · 140.0K tokens · 180 tool calls"),
			"totals sum both runs incl. the failed attempt",
		);
	});

	it("retry also fails → two FAILED rows, both counted, pipeline stops", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Failed to implement",
				textOnly: "Failed to implement",
				durationMs: 500_000,
				tokenCount: 10_000,
				toolCount: 20,
			}),
			makeDevResult({
				success: false,
				textOutput: "Failed again",
				textOnly: "Failed again",
				durationMs: 300_000,
				tokenCount: 8_000,
				toolCount: 15,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runCtx.agentResults.length, 2, "both failed runs documented");
		for (const entry of runCtx.agentResults) {
			assert.equal(entry.status, "FAILED", "no retry label masks a failed retry");
		}
		assert.ok(
			runCtx.stopReason?.includes("failed"),
			`pipeline stops on retry failure (Bug #711), got: ${runCtx.stopReason}`,
		);

		const summary = buildPipelineSummary(
			runCtx.agentResults,
			"failed",
			1494,
			"Test issue",
			SUMMARY_CONFIG,
		);
		assert.ok(
			summary.includes("**Total:** 2 runs · 13m 20s · 18.0K tokens · 35 tool calls"),
			"totals count both failed runs",
		);
	});

	it("budget-exceeded first run → retry skipped, single entry (unchanged)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: false,
				textOutput: "Exceeded budget",
				textOnly: "Exceeded budget",
				budgetExceeded: true,
				durationMs: 600_000,
				tokenCount: 120_000,
				toolCount: 300,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runCtx.agentResults.length, 1, "budget-exceeded is not retried");
		assert.equal(runCtx.agentResults[0]?.status, "FAILED");
		assert.equal(runCtx.agentResults[0]?.durationMs, 600_000);
	});

	it("successful first run → single SUCCESS entry, usedRetry=false (unchanged)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		const runner = createQueueRunner([
			makeDevResult({
				success: true,
				textOutput: "Implemented\nIMPLEMENTATION_COMPLETE",
				durationMs: 900_000,
				tokenCount: 50_000,
				toolCount: 60,
			}),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runCtx.agentResults.length, 1, "single dispatch → single entry");
		assert.equal(runCtx.agentResults[0]?.status, "SUCCESS");
		assert.equal(runCtx.agentResults[0]?.durationMs, 900_000);
	});

	it("validateAgentResult ordering preserved: derated run retries and FAILED row shows sanity check", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "agent-loop-retry-cwd-"));
		const wt = makeWorktree();
		const portCalls: PortCall[] = [];
		// First run claims success but has 0 tokens with >5 tools — the sanity
		// check derates it to failed BEFORE the retry decision, so it retries
		// and the FAILED row carries the sanity-check errorOutput.
		const runner = createQueueRunner([
			makeDevResult({
				success: true,
				tokenCount: 0,
				toolCount: 10,
				durationMs: 400_000,
			}),
			makeDevResult({ success: true, durationMs: 200_000, tokenCount: 30_000, toolCount: 40 }),
		]);

		const runCtx = buildRetryRunContext({ runner, portCalls, tmpCwd, wt });
		await runAgentLoop(runCtx);

		assert.equal(runCtx.agentResults.length, 2, "derated run still retried");
		const [failed, retried] = runCtx.agentResults;
		assert.equal(failed.status, "FAILED");
		assert.ok(
			failed.errorOutput?.includes("Sanity check failed"),
			"FAILED row surfaces the derate diagnostics",
		);
		assert.equal(failed.tokenCount, 0, "derated run keeps its 0 tokens");
		assert.equal(retried.status, "SUCCESS (after retry)");
	});
});
