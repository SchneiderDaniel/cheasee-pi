import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { PipelineAgentResult, PrCreationResult, PrConflictInfo } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

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

function createMockCtx(confirmResult: boolean = true): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: mock.fn(),
			confirm: async () => confirmResult,
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

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

function makeConflictInfo(hasConflict: boolean): PrConflictInfo {
	return {
		number: 123,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

function createMockMergePort(hasConflict: boolean = true): GitHubPort {
	return createMockGitHubPort({
		listPullRequestsForBranch: async () => makeConflictInfo(hasConflict),
	});
}

import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";

import { createStageState } from "../../pipeline/stages/index.ts";

import { ErrorCollector } from "../../pipeline/error-collector.ts";

import type { AgentRunResult, ProjectField, ProjectItem } from "../../config/types.ts";

import type { RunContext } from "../../pipeline/handler/shared.ts";

import type { PortCall } from "../helper/mock-github-port.ts";

const AUDITOR_APPROVED_OUTPUT = [
	"## Audit Complete",
	"",
	"```json",
	JSON.stringify({
		action: "APPROVED",
		agentName: "auditor",
		summary: "Audit approved",
		commentBody: "## Audit Approved\n\nAll dimensions verified.",
		auditScore: { passing: 6, total: 6 },
	}),
	"```",
].join("\n");

function makeHarnessRunnerResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "auditor",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: AUDITOR_APPROVED_OUTPUT,
		textOnly: AUDITOR_APPROVED_OUTPUT,
		summaryLine: "Audit approved",
		errorOutput: "",
		...overrides,
	};
}

function createHarnessRunner(devSuccess: boolean) {
	return mock.fn(async (...args: any[]) => {
		const agent = args[0]?.agent as { config: { name: string } };
		if (agent?.config?.name === "developer") {
			return makeHarnessRunnerResult({
				agentName: "developer",
				success: devSuccess,
				summaryLine: devSuccess ? "Resolved merge conflicts" : "Could not resolve conflicts",
				textOutput: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
				textOnly: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
			});
		}
		return makeHarnessRunnerResult({});
	});
}

const GATE_FIELDS: ProjectField[] = [
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

const GATE_STATUS_FIELD = GATE_FIELDS[0]!;

const GATE_LOOP_ITEM: ProjectItem = { id: "item-1" };

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

function buildGateRunContext(opts: {
	execResults: Array<{ code: number; stdout: string; stderr: string }>;
	runner: ReturnType<typeof mock.fn>;
	portCalls: PortCall[];
	tmpCwd: string;
	wt: string;
}): RunContext {
	const execCalls: ExecCall[] = [];
	const pi = createMockPi(opts.execResults, execCalls);
	const ctx = createMockCtx(true);
	const ctxWithCwd = { ...ctx, cwd: opts.tmpCwd } as unknown as ExtensionCommandContext;

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
		ctx: ctxWithCwd,
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
			number: 42,
			title: "Test issue",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: createStageState("Audit"),
		loopStatus: "Audit",
		loopItem: GATE_LOOP_ITEM,
		fields: GATE_FIELDS,
		statusField: GATE_STATUS_FIELD,
		projectId: "project-1",
		worktreePath: opts.wt,
		worktreeBranch: "worktree-git-issue-42-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

function makeGateWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "handler-gate-wt-"));
	const agentDir = join(dir, ".pi/extensions/supervisor/agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "developer.md"), "---\nname: developer\n---\n\nTest dev.", "utf-8");
	return dir;
}

describe("runAgentLoop — pre-Done PR readiness gate (issue #1472)", () => {
	it("auditor success + createPrOnApproval success + gate ok → Done applied (normal completion unchanged)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(true);

		const runCtx = buildGateRunContext({
			execResults: [
				{ code: 0, stdout: "fetch ok", stderr: "" }, // rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // push
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(transitions.includes("opt-done"), "Done transition applied");
		assert.ok(!transitions.includes("opt-implementation"), "no Implementation transition");
		assert.equal(runCtx.loopStatus, "Done");
		assert.equal(runCtx.stopReason, undefined, "no stop reason on the normal path");
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			1,
			"PR created once",
		);
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("auditor success + rebaseConflicts + developer resolves + retry ok → Done applied (recovery path)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(true);

		const runCtx = buildGateRunContext({
			execResults: [
				// createPrOnApproval rebase fails with conflicts
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 1 rebase fetch
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // 2 rebase fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 3 diff
				{ code: 0, stdout: "", stderr: "" }, // 4 rebase --abort
				{ code: 1, stdout: "", stderr: "merge failed" }, // 5 merge fallback fails
				{ code: 0, stdout: "", stderr: "" }, // 6 merge --abort
				// gate: resolveBranchConflicts → tryAutoMerge fails → dev dispatch
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 7 merge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // 8 merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 9 diff
				{ code: 0, stdout: "", stderr: "" }, // 10 merge --abort
				// gate: bounded retry of createPrOnApproval succeeds
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 11 retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // 12 retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // 13 retry push
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(transitions.includes("opt-done"), "Done applied after conflict resolution");
		assert.ok(!transitions.includes("opt-implementation"), "no Implementation transition");
		assert.equal(runCtx.loopStatus, "Done");
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			1,
			"createPrOnApproval retried exactly once after resolution",
		);
		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.agent?.config?.name === "developer",
		);
		assert.equal(devCalls.length, 1, "exactly one developer dispatch for conflict resolution");
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("gate { ok: false } → no Done transition; issue moved to Implementation; blocker comment posted; loop breaks with stopReason", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(false); // developer fails to resolve

		const runCtx = buildGateRunContext({
			execResults: [
				// createPrOnApproval rebase fails with conflicts
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 1
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // 2
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 3
				{ code: 0, stdout: "", stderr: "" }, // 4
				{ code: 1, stdout: "", stderr: "merge failed" }, // 5
				{ code: 0, stdout: "", stderr: "" }, // 6
				// gate: resolveBranchConflicts → tryAutoMerge fails → dev dispatch FAILS
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 7
				{ code: 1, stdout: "", stderr: "merge failed" }, // 8
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 9
				{ code: 0, stdout: "", stderr: "" }, // 10
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(
			!transitions.includes("opt-done"),
			"Done transition must NOT be applied when the gate blocks",
		);
		assert.ok(
			transitions.includes("opt-implementation"),
			"issue transitions to Implementation (non-Done)",
		);
		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("PR Readiness Blocked")),
			"blocker comment posted",
		);
		assert.ok(
			comments.some((b) => b.includes("Manual Intervention Required")),
			"blocker comment demands manual intervention",
		);
		assert.ok(runCtx.stopReason?.includes("PR readiness"), "stopReason set from gate verdict");
		assert.equal(runCtx.loopStatus, "Implementation", "loop leaves issue in non-Done status");
		assert.ok(
			runCtx.prCreationResult && !runCtx.prCreationResult.success,
			"failed prCreationResult propagated for post-pipeline phase",
		);
		assert.deepEqual(
			runCtx.prCreationResult!.rebaseConflicts,
			["src/a.ts"],
			"rebase conflicts propagated",
		);
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});
});
