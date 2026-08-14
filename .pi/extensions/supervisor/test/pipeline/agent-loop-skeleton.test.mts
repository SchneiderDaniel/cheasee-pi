// ─── Tests: runAgentLoop dispatch skeleton (issue #1533) ─────────
// End-to-end through the real runAgentLoop with an injected mock agent
// runner + scripted pi.exec. Proves the dispatch skeleton translates the
// extracted helpers' control-flow signals into break/continue with the
// same observable behavior as the pre-split monolith. All scenarios stop
// BEFORE the Implementation→Audit hooks chain (no real runTscAndLspAudit).

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

// ─── Mock helpers (mirror agent-loop-retry.test.mts) ─────────────

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

/** pi.exec dispatcher: scripts the empty-worktree git signals, passes everything else. */
function emptyWorktreePi(opts: {
	revList?: string;
	cherry?: string;
	diffCode?: number;
	logSha?: string;
}): ExtensionAPI {
	return createMockPi(async (cmd, args) => {
		if (cmd === "git" && args[0] === "rev-list")
			return { code: 0, stdout: opts.revList ?? "0", stderr: "" };
		if (cmd === "git" && args[0] === "cherry")
			return { code: 0, stdout: opts.cherry ?? "", stderr: "" };
		if (cmd === "git" && args[0] === "diff" && args[1] === "--quiet") {
			return { code: opts.diffCode ?? 1, stdout: "", stderr: "" };
		}
		if (cmd === "git" && args[0] === "log")
			return { code: 0, stdout: opts.logSha ?? "abc123", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
}

// ─── Tests ────────────────────────────────────────────────────────

const WT = mkdtempSync(join(tmpdir(), "skeleton-wt-"));

describe("runAgentLoop skeleton — empty-worktree dispatch (issue #1533)", () => {
	function runEmptyWorktree(opts: {
		diffCode: number;
		prs?: Array<{ number: number; sha?: string; source: string; branch: string; state: string }>;
		getClosingPrsThrows?: boolean;
	}): { runCtx: RunContext; portCalls: PortCall[]; notify: ReturnType<typeof mock.fn> } {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				getClosingPrsForIssue: async () => {
					if (opts.getClosingPrsThrows) throw new Error("API down");
					return (opts.prs ?? []) as never;
				},
				postIssueComment: async () => {},
				closeIssue: async () => {},
				setItemStatusField: async () => {},
			},
			portCalls,
		);
		const notify = mock.fn();
		const pi = emptyWorktreePi({ diffCode: opts.diffCode });
		const runner = mock.fn(async (...args: any[]) => {
			const agent = args[0] as { config?: { name?: string } };
			if (agent?.config?.name !== "developer") {
				return makeDevResult({
					success: false,
					errorOutput: `unexpected agent: ${agent?.config?.name}`,
				});
			}
			return makeDevResult({ success: true });
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Implementation",
			worktreePath: WT,
		});
		return { runCtx, portCalls, notify };
	}

	it("no commits + no changeOnMain → loop-back: classify reason, NO transition/comment/close, loopStatus stays Implementation", async () => {
		const { runCtx, portCalls } = runEmptyWorktree({ diffCode: 1 });
		await runAgentLoop(runCtx);
		assert.ok(
			runCtx.stopReason?.includes("No commits"),
			`stopReason = classify reason, got: ${runCtx.stopReason}`,
		);
		const transitions = portCalls.filter((c) => c.method === "setItemStatusField");
		assert.equal(transitions.length, 0, "no status transition on loop-back");
		assert.ok(!portCalls.some((c) => c.method === "postIssueComment"), "no comment on loop-back");
		assert.ok(!portCalls.some((c) => c.method === "closeIssue"), "no close on loop-back");
		assert.equal(runCtx.loopStatus, "Implementation", "loopStatus write-back unchanged");
	});

	it("no commits + changeOnMain (diff clean) → close flow: comment + closeIssue", async () => {
		const { runCtx, portCalls } = runEmptyWorktree({ diffCode: 0 });
		await runAgentLoop(runCtx);
		assert.ok(
			runCtx.stopReason?.includes("Changes already on main"),
			`close reason, got: ${runCtx.stopReason}`,
		);
		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("Issue Already Resolved")),
			"resolved comment posted",
		);
		assert.ok(
			portCalls.some((c) => c.method === "closeIssue"),
			"issue closed",
		);
		assert.equal(runCtx.loopStatus, "Implementation");
	});

	it("open PR exists → leave open: PR-link comment, closeIssue NOT called", async () => {
		const { runCtx, portCalls } = runEmptyWorktree({
			diffCode: 0,
			prs: [{ number: 99, sha: "def", source: "branch-head", branch: "pr-branch", state: "open" }],
		});
		await runAgentLoop(runCtx);
		assert.ok(
			runCtx.stopReason?.includes("Open PR #99"),
			`leave-open reason, got: ${runCtx.stopReason}`,
		);
		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("Open PR #99")),
			"PR link comment posted",
		);
		assert.ok(!portCalls.some((c) => c.method === "closeIssue"), "issue NOT closed");
	});

	it("getClosingPrsForIssue throws → loop-back (fail-open), no close", async () => {
		const { runCtx, portCalls } = runEmptyWorktree({ diffCode: 0, getClosingPrsThrows: true });
		await runAgentLoop(runCtx);
		assert.ok(
			runCtx.stopReason?.includes("No commits"),
			"port failure forces loop-back, not close",
		);
		assert.ok(!portCalls.some((c) => c.method === "closeIssue"), "no close after port failure");
		assert.ok(
			!portCalls.some((c) => c.method === "postIssueComment"),
			"no comment after port failure",
		);
	});
});

describe("runAgentLoop skeleton — researcher budget degradation (issue #1533)", () => {
	it("budgetExceeded+!success → degradation comment + Research→Architecture transition + loop continues", async () => {
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
			const agent = args[0] as { config?: { name?: string } };
			if (agent?.config?.name === "researcher") {
				return makeDevResult({
					agentName: "researcher",
					success: false,
					budgetExceeded: true,
					tokenCount: 120_000,
					toolCount: 300,
					textOutput: "Exceeded budget",
					textOnly: "Exceeded budget",
				});
			}
			// architect (post-continue) fails hard → explicit-marker stop
			return makeDevResult({
				agentName: "architect",
				success: false,
				textOutput: "crash",
				textOnly: "crash",
			});
		});
		const runCtx = buildRunContext({
			runner,
			port,
			pi,
			notify,
			loopStatus: "Research",
			worktreePath: WT,
		});
		await runAgentLoop(runCtx);

		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("Research stopped early")),
			"degradation comment posted with the 'stopped early' header",
		);
		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(
			transitions.includes("opt-architecture"),
			"Research → Architecture transition applied",
		);
		assert.equal(runCtx.loopStatus, "Architecture", "loop continued past the researcher");
		assert.ok(
			runCtx.stopReason?.includes("no explicit completion marker"),
			"loop eventually stopped by the architect crash",
		);
		assert.equal(
			runCtx.agentResults.filter((a) => a.agentName === "researcher").length,
			1,
			"researcher dispatched exactly once (no retry on budget)",
		);
	});

	it("non-researcher budgetExceeded → stopReason 'exceeded budget', loop stops", async () => {
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
			const agent = args[0] as { config?: { name?: string } };
			if (agent?.config?.name === "architect") {
				return makeDevResult({
					agentName: "architect",
					success: false,
					budgetExceeded: true,
					tokenCount: 50_000,
					toolCount: 200,
					textOutput: "Exceeded budget",
					textOnly: "Exceeded budget",
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
		assert.ok(
			runCtx.stopReason?.includes("exceeded budget"),
			`non-researcher budget stops the pipeline, got: ${runCtx.stopReason}`,
		);
		assert.equal(runCtx.agentResults.length, 1, "single dispatch, no retry on budget");
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
			const agent = args[0] as { config?: { name?: string } };
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
