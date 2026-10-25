import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { PipelineAgentResult, PrCreationResult, PrConflictInfo } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import { handlePostPipeline } from "../../pipeline/handler.ts";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

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

describe("handlePostPipeline() — merge/cleanup ordering (Phase 1)", () => {
	it("calls handlePostPipelineMerge before cleanupWorktree (call order: merge, cleanup)", async () => {
		const calls: ExecCall[] = [];
		// PR conflict check is now via port — git fetch/merge/push are still exec calls
		const pi = createMockPi(
			[
				// 1. tryAutoMerge: git fetch origin main
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. tryAutoMerge: git merge origin/main --no-edit
				{ code: 0, stdout: "merge ok", stderr: "" },
				// 3. git push
				{ code: 0, stdout: "push ok", stderr: "" },
				// 4. cleanupWorktree: git worktree remove --force
				{ code: 0, stdout: "", stderr: "" },
				// 5. cleanupWorktree: git worktree prune
				{ code: 0, stdout: "", stderr: "" },
				// 6. cleanupWorktree: git branch -D
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Merge calls (git fetch, merge, push) come before cleanup calls
		const mergeCalls = calls.filter(
			(c) =>
				c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);

		assert.ok(mergeCalls.length > 0, "should have merge-related exec calls");
		assert.ok(cleanupCalls.length > 0, "should have cleanup exec calls");

		// All merge calls must come before any cleanup call
		const lastMergeIdx = calls.lastIndexOf(mergeCalls[mergeCalls.length - 1]);
		const firstCleanupIdx = calls.indexOf(cleanupCalls[0]);
		assert.ok(
			lastMergeIdx < firstCleanupIdx,
			`merge calls (indices 0..${lastMergeIdx}) must precede cleanup calls (index ${firstCleanupIdx})`,
		);
	});
	it("calls both merge and cleanup when merge succeeds", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
				{ code: 0, stdout: "push ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Both merge and cleanup calls present
		const hasMerge = calls.some(
			(c) =>
				c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		const hasCleanup = calls.some((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(hasMerge, "merge calls should be present");
		assert.ok(hasCleanup, "cleanup calls should be present");
	});
	it("still calls cleanupWorktree when handlePostPipelineMerge succeeds (no-conflict path)", async () => {
		const calls: ExecCall[] = [];
		// No-conflict path: port.listPullRequestsForBranch returns non-conflicting PR, no tryAutoMerge
		const pi = createMockPi(
			[
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// cleanup should still run even though no auto-merge was needed
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when no merge needed");
	});
	it("skips merge when isDoneStatus is false, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Architecture", // not Done
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// No merge calls when not Done
		const gitFetchMergeCalls = calls.filter(
			(c) =>
				c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		assert.equal(gitFetchMergeCalls.length, 0, "no merge calls when not Done");

		// Cleanup should still run
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when merge skipped");
	});
	it("skips merge when agentResults is empty, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[], // empty agentResults
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// No merge calls when agentResults empty
		const gitFetchMergeCalls = calls.filter(
			(c) =>
				c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		assert.equal(gitFetchMergeCalls.length, 0, "no merge calls when agentResults empty");

		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run");
	});
});
