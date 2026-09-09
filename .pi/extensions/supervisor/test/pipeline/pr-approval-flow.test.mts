// ─── Tests: handlePrApprovalFlow (issue #1533 extraction) ────────
// Unit tests for the audit-approval → PR-creation + readiness-gate glue
// extracted from runAgentLoop into handler/pr-gates.ts. Harness mirrors
// handler.test.mts (scripted pi.exec + PR-lifecycle port). The blocked
// path must propagate the failed prCreationResult AND the non-Done
// loopStatus — pinned by handler.test.mts through runAgentLoop.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import type { PortCall } from "../helper/mock-github-port.ts";
import { handlePrApprovalFlow } from "../../pipeline/handler/pr-gates.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";

/**
 * Mock ExtensionAPI matching the REAL pi.exec contract: always RESOLVES
 * {code, stdout, stderr, killed} — never rejects on non-zero exit
 * (pi-core execCommand resolves {code} even for failed commands).
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string; killed?: boolean }>,
	calls?: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
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

/**
 * Drain the microtask queue (setImmediate fires only once the microtask
 * queue is empty) so a pending mock-timer retry delay can be ticked. Node 22
 * MockTimers has no tickAsync — tick() is synchronous, so each delay needs
 * flush → tick → flush.
 */
function flushQueue(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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

const mockConfig = {
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
	agentTimeoutsMin: {},
};

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
const STATUS_FIELD = FIELDS[0]!;
const LOOP_ITEM = { id: "item-1" };

function makeGateCleanInfo(): PrConflictInfo {
	return {
		number: 456,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

function buildRunContext(opts: {
	execResults: Array<{ code: number; stdout: string; stderr: string }>;
	runner: ReturnType<typeof mock.fn>;
	portCalls: PortCall[];
}): RunContext {
	const pi = createMockPi(opts.execResults);
	const ctx = createMockCtx();
	let prCreated = false;
	const port = createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => (prCreated ? makeGateCleanInfo() : null),
			createPullRequest: async () => {
				prCreated = true;
				return { number: 456 };
			},
			updatePullRequest: async () => {},
			postIssueComment: async () => {},
			getClosingPrsForIssue: async () => [],
		},
		opts.portCalls,
	);
	return {
		args: undefined,
		ctx,
		pi,
		issueNum: 42,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 42,
						title: "Test",
						body: "b",
						author: { login: "u" },
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
		issueData: { number: 42, title: "Test", body: "b", author: { login: "u" }, comments: [] },
		stageState: createStageState("Audit"),
		loopStatus: "Audit",
		loopItem: LOOP_ITEM,
		fields: FIELDS as any,
		statusField: STATUS_FIELD as any,
		projectId: "project-1",
		worktreePath: "/tmp/wt",
		worktreeBranch: "worktree-git-issue-42-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

function makeRunnerResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "developer",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: "Resolved\nCONFLICTS_RESOLVED",
		textOnly: "Resolved\nCONFLICTS_RESOLVED",
		summaryLine: "Resolved merge conflicts",
		errorOutput: "",
		...overrides,
	};
}

function createGateRunner(devSuccess: boolean) {
	return mock.fn(async (...args: any[]) => {
		const agent = args[0] as { config?: { name?: string } };
		if (agent?.config?.name === "developer") {
			return makeRunnerResult({
				success: devSuccess,
				summaryLine: devSuccess ? "Resolved merge conflicts" : "Could not resolve conflicts",
				textOutput: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
				textOnly: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
			});
		}
		return makeRunnerResult({});
	});
}

describe("handlePrApprovalFlow — audit approval → PR creation + gate (issue #1533)", () => {
	it("gate ok → { stop: false }, prCreationResult propagated (PR created)", async () => {
		const portCalls: PortCall[] = [];
		const runner = createGateRunner(true);
		const runCtx = buildRunContext({
			execResults: [
				{ code: 0, stdout: "fetch ok", stderr: "" }, // rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // push
			],
			runner,
			portCalls,
		});
		const outcome = await handlePrApprovalFlow(runCtx, "Audit");
		assert.equal(outcome.stop, false);
		if (!outcome.stop) {
			assert.ok(outcome.prCreationResult, "prCreationResult propagated");
			assert.equal(
				portCalls.filter((c) => c.method === "createPullRequest").length,
				1,
				"PR created once",
			);
		}
	});

	it("gate blocked (dev cannot resolve) → { stop: true }, loopStatus Implementation, stopReason from gate, failed prCreationResult propagated", async () => {
		const portCalls: PortCall[] = [];
		const runner = createGateRunner(false);
		const runCtx = buildRunContext({
			execResults: [
				// createPrOnApproval rebase fails with conflicts
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 1 rebase fetch
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // 2 rebase fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 3 diff
				{ code: 0, stdout: "", stderr: "" }, // 4 rebase --abort
				{ code: 1, stdout: "", stderr: "merge failed" }, // 5 merge fallback fails
				{ code: 0, stdout: "", stderr: "" }, // 6 merge --abort
				// gate: resolveBranchConflicts → tryAutoMerge fails → dev dispatch FAILS
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 7 merge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // 8 merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 9 diff
				{ code: 0, stdout: "", stderr: "" }, // 10 merge --abort
			],
			runner,
			portCalls,
		});
		const outcome = await handlePrApprovalFlow(runCtx, "Audit");
		assert.ok(outcome.stop, "blocked verdict stops the loop");
		if (outcome.stop) {
			assert.ok(
				outcome.stopReason.includes("PR readiness"),
				"stopReason from blockPipelineOnPrGate",
			);
			assert.equal(outcome.loopStatus, "Implementation", "issue moved to non-Done status");
			assert.ok(
				outcome.prCreationResult && !outcome.prCreationResult.success,
				"failed prCreationResult propagated for post-pipeline phase",
			);
			assert.deepEqual(
				outcome.prCreationResult.rebaseConflicts,
				["src/a.ts"],
				"rebase conflicts propagated",
			);
			const comments = portCalls
				.filter((c) => c.method === "postIssueComment")
				.map((c) => c.args[2] as string);
			assert.ok(
				comments.some((b) => b.includes("PR Readiness Blocked")),
				"blocker comment posted",
			);
		}
	});

	it("gate ok path never moves the issue (no Implementation transition)", async () => {
		const portCalls: PortCall[] = [];
		const runner = createGateRunner(true);
		const runCtx = buildRunContext({
			execResults: [
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			runner,
			portCalls,
		});
		const outcome = await handlePrApprovalFlow(runCtx, "Audit");
		assert.equal(outcome.stop, false);
		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(!transitions.includes("opt-implementation"), "no Implementation transition on ok");
	});

	it("gate blocked — push {code:1} → failed prCreationResult propagated, zero createPullRequest", async () => {
		const portCalls: PortCall[] = [];
		const runner = createGateRunner(true);
		// The readiness gate retries createPrOnApproval once (creation-failed
		// mode), so BOTH rounds must fail the push. Each round: rebase fetch,
		// rebase, push ×3 with lease-refresh fetch between retries.
		const failingRound = [
			{ code: 0, stdout: "fetch ok", stderr: "" }, // rebase fetch
			{ code: 0, stdout: "rebase ok", stderr: "" }, // rebase
			{ code: 1, stdout: "", stderr: "rejected" }, // push attempt 1
			{ code: 0, stdout: "prune ok", stderr: "" }, // fetch --prune
			{ code: 1, stdout: "", stderr: "rejected" }, // push attempt 2
			{ code: 0, stdout: "prune ok", stderr: "" }, // fetch --prune
			{ code: 1, stdout: "", stderr: "rejected" }, // push attempt 3
		];
		const runCtx = buildRunContext({
			execResults: [...failingRound, ...failingRound],
			runner,
			portCalls,
		});

		mock.timers.enable({ apis: ["setTimeout"] });
		let outcome: Awaited<ReturnType<typeof handlePrApprovalFlow>>;
		try {
			const promise = handlePrApprovalFlow(runCtx, "Audit");
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			outcome = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(
			outcome.prCreationResult?.success,
			false,
			"failed push must propagate prCreationResult.success === false",
		);
		assert.ok(
			outcome.prCreationResult?.error!.includes("rejected"),
			"push stderr excerpt propagated in error",
		);
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			0,
			"zero createPullRequest calls after failed push",
		);
	});

	it("gate blocked — push {code:0, killed:true} → same failed propagation (flow-level killed gate)", async () => {
		const portCalls: PortCall[] = [];
		const runner = createGateRunner(true);
		const failingRound = [
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "rebase ok", stderr: "" },
			{ code: 0, stdout: "", stderr: "", killed: true },
			{ code: 0, stdout: "prune ok", stderr: "" },
			{ code: 0, stdout: "", stderr: "", killed: true },
			{ code: 0, stdout: "prune ok", stderr: "" },
			{ code: 0, stdout: "", stderr: "", killed: true },
		];
		const runCtx = buildRunContext({
			execResults: [...failingRound, ...failingRound],
			runner,
			portCalls,
		});

		mock.timers.enable({ apis: ["setTimeout"] });
		let outcome: Awaited<ReturnType<typeof handlePrApprovalFlow>>;
		try {
			const promise = handlePrApprovalFlow(runCtx, "Audit");
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			outcome = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(
			outcome.prCreationResult?.success,
			false,
			"timeout-killed push must propagate failure at flow level too",
		);
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			0,
			"zero createPullRequest calls after killed push",
		);
	});

	it("unused import guard — PipelineAgentResult type referenced (harness sanity)", () => {
		const entry: PipelineAgentResult = {
			agentName: "auditor",
			status: "SUCCESS",
			durationMs: 1,
			tokenCount: 1,
			toolCount: 1,
		};
		assert.equal(entry.status, "SUCCESS");
	});
});
