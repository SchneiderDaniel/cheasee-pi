/**
 * Tests for the pipeline handler — behavior coverage (issue #1866).
 *
 * The former source-text Phase 2 checks (worktree-before-loop, buildAgentTask
 * arg shape, agentCwd, retry, budget-exceeded guard) were text pins that broke
 * on reformat and rename. Their behavior is owned by the agent-loop / stages
 * suites (agent-loop-skeleton.test.mts, pipeline/agent-loop-retry.test.mts,
 * pipeline/stages.test.mts); the worktree lifecycle by pipeline/worktree.test.mts.
 *
 * This file now invokes the handlers and observes their effects:
 *   - handlePostPipeline cleanup with/without worktree path (exec spy)
 *   - runAgentLoop post-agent-success gate with a mocked runner
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult } from "../config/types.ts";
import type { RunContext } from "../pipeline/handler/shared.ts";
import { handlePostPipeline } from "../pipeline/handler/post-pipeline.ts";
import { createStageState } from "../pipeline/stages/index.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";

// ---------------------------------------------------------------------------
// Behavior coverage converted from source-text assertions (issue #1866)
// ---------------------------------------------------------------------------
// The former "cleanup guarded by worktreePath" / "cleanup calls cleanupWorktree"
// and "handlePostAgentSuccess called when result.success" string checks are
// replaced by tests that invoke the handlers and observe their effects.

const CLEANUP_CONFIG = {
	defaultBranch: "main",
	branchPrefix: "worktree-git-issue-",
	remote: "origin",
	repo: "owner/repo",
} as SupervisorConfig;

function makeExecSpy(): {
	calls: Array<{ cmd: string; args: string[] }>;
	exec: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
} {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push({ cmd, args: args ?? [] });
		return { code: 0, stdout: "", stderr: "" };
	};
	return { calls, exec };
}

function makeBehaviorCtx(): ExtensionCommandContext {
	return {
		cwd: mkdtempSync(join(tmpdir(), "sup-pipeline-cwd-")),
		ui: { notify: () => {}, setStatus: () => {} },
	} as unknown as ExtensionCommandContext;
}

describe("pipeline handler — worktree cleanup behavior (issue #1866)", () => {
	it("does not remove a worktree when worktreePath is undefined", async () => {
		const { calls, exec } = makeExecSpy();
		const pi = { exec } as unknown as ExtensionAPI;
		await handlePostPipeline(
			1,
			"t",
			"Implementation",
			[],
			CLEANUP_CONFIG,
			pi,
			makeBehaviorCtx(),
			undefined,
			undefined,
		);
		assert.ok(
			!calls.some((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove"),
			"cleanupWorktree is skipped without a worktree path",
		);
	});

	it("removes the worktree exactly once when path + branch are set", async () => {
		const { calls, exec } = makeExecSpy();
		const pi = { exec } as unknown as ExtensionAPI;
		await handlePostPipeline(
			1,
			"t",
			"Implementation",
			[],
			CLEANUP_CONFIG,
			pi,
			makeBehaviorCtx(),
			"/wt/issue-1",
			"worktree-git-issue-1-test",
		);
		const removes = calls.filter(
			(c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
		);
		assert.equal(removes.length, 1, "cleanupWorktree is invoked exactly once");
		assert.ok(removes[0]!.args.includes("/wt/issue-1"), "removes the issue worktree path");
	});
});

// ─── runAgentLoop harness for the post-agent-success gate ────────

const LOOP_CONFIG: SupervisorConfig = {
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

const STATUS_FIELDS = [
	{
		id: "status-field-id",
		name: "Status",
		type: "single_select",
		options: [
			{ id: "opt-research", name: "Research" },
			{ id: "opt-architecture", name: "Architecture" },
			{ id: "opt-test-design", name: "TestDesign" },
			{ id: "opt-implementation", name: "Implementation" },
			{ id: "opt-audit", name: "Audit" },
			{ id: "opt-done", name: "Done" },
		],
	},
];

function makeAgentResult(agentName: string, overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName,
		toolCount: 1,
		tokenCount: 10,
		durationMs: 1000,
		textOutput: "",
		textOnly: "",
		summaryLine: "did work",
		errorOutput: "",
		...overrides,
	};
}

function buildArchitectRunContext(opts: {
	results: AgentRunResult[];
	postIssueComment: ReturnType<typeof mock.fn>;
}): RunContext {
	const runner = mock.fn(async () =>
		opts.results.shift() ??
		makeAgentResult("architect", { success: false, textOutput: "failed", textOnly: "failed" }),
	);
	return {
		args: undefined,
		ctx: makeBehaviorCtx(),
		pi: {
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			sendMessage: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		issueNum: 1866,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 1866,
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
		config: LOOP_CONFIG,
		port: {
			getClosingPrsForIssue: async () => [],
			postIssueComment: opts.postIssueComment,
			closeIssue: async () => {},
			setItemStatusField: async () => {},
		} as any,
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: {
			number: 1866,
			title: "Test issue",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: createStageState("Architecture"),
		loopStatus: "Architecture",
		loopItem: { id: "item-1" },
		fields: STATUS_FIELDS as any,
		statusField: STATUS_FIELDS[0] as any,
		projectId: "project-1",
		worktreePath: mkdtempSync(join(tmpdir(), "sup-pipeline-wt-")),
		worktreeBranch: "worktree-git-issue-1866-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: runner,
	} as unknown as RunContext;
}

describe("pipeline handler — post-agent-success gate (behavior, issue #1866)", () => {
	it("architect success runs post-success processing and posts the comment", async () => {
		const postIssueComment = mock.fn(async () => {});
		const runCtx = buildArchitectRunContext({
			results: [
				makeAgentResult("architect", {
					textOutput: "## Architecture\n\nDesign details",
					textOnly: "## Architecture\n\nDesign details",
				}),
			],
			postIssueComment,
		});
		const { runAgentLoop } = await import("../pipeline/handler/agent-loop.ts");
		await runAgentLoop(runCtx);
		assert.equal(postIssueComment.mock.callCount(), 1, "architect comment posted on success");
	});

	it("architect failure skips post-success processing and stops the pipeline", async () => {
		const postIssueComment = mock.fn(async () => {});
		const runCtx = buildArchitectRunContext({
			results: [makeAgentResult("architect", { success: false, textOutput: "boom", textOnly: "boom" })],
			postIssueComment,
		});
		const { runAgentLoop } = await import("../pipeline/handler/agent-loop.ts");
		await runAgentLoop(runCtx);
		assert.equal(postIssueComment.mock.callCount(), 0, "no post-success processing on failure");
		assert.ok(runCtx.stopReason, "pipeline stops when the agent fails");
	});
});
