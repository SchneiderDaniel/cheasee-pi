import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { PipelineAgentResult, PrCreationResult, PrConflictInfo } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import { handlePostPipeline } from "../../pipeline/handler.ts";

import {
	writeCheckpointFile,
	readCheckpointFileFromPath,
} from "../../pipeline/state-checkpoint.ts";

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";

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
	describe("handlePostPipeline — deleteCheckpointFile integration (Phase 4)", () => {
		it("calls deleteCheckpointFile in finally block (state file deleted after run)", async () => {
			// Create a temp dir with a state file
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-delete-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			// Write a state file before calling handlePostPipeline
			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-auditor",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const statePath = join(tmpDir, ".pi", "supervisor-state-42.json");
			assert.equal(existsSync(statePath), true);

			// Create ctx with tmpDir as cwd
			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			// Run handlePostPipeline — merge skipped (non-Done status), cleanup runs
			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git worktree remove
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git worktree prune
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git branch -D
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Architecture", // not Done → merge skipped
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
			);

			// State file should be deleted after handlePostPipeline runs
			assert.equal(
				existsSync(statePath),
				false,
				"state file should be deleted after handlePostPipeline",
			);

			// Cleanup temp dir
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("deleteCheckpointFile runs even when handlePostPipelineMerge throws", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-merge-throws-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			// Write a state file before calling handlePostPipeline
			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-auditor",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const statePath = join(tmpDir, ".pi", "supervisor-state-42.json");
			assert.equal(existsSync(statePath), true);

			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			// handlePostPipelineMerge will fail (port.listPullRequestsForBranch throws)
			const port = createMockGitHubPort({
				listPullRequestsForBranch: async () => {
					throw new Error("network error");
				},
			});
			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					// cleanup still runs
					{ code: 0, stdout: "", stderr: "" },
					{ code: 0, stdout: "", stderr: "" },
					{ code: 0, stdout: "", stderr: "" },
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Done",
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				undefined,
				port,
			);

			// State file should still be deleted (finally block runs)
			assert.equal(
				existsSync(statePath),
				false,
				"state file should be deleted even when merge throws",
			);

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("deleteCheckpointFile called in finally after cleanup completes", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-order-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-tsc",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					// cleanup: git worktree remove
					{ code: 0, stdout: "", stderr: "" },
					// cleanup: git worktree prune
					{ code: 0, stdout: "", stderr: "" },
					// cleanup: git branch -D
					{ code: 0, stdout: "", stderr: "" },
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Architecture",
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
			);

			// The state file should be deleted — verify by reading
			const readResult = readCheckpointFileFromPath(
				join(tmpDir, ".pi", "supervisor-state-42.json"),
			);
			assert.equal(readResult, null, "state file should be deleted");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});
});
