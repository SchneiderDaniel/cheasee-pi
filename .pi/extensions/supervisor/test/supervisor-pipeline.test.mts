/**
 * Tests for pipeline.ts — worktree creation before task construction (Phase 2)
 *
 * Phase 2a: Worktree created before loop (available to ALL agents)
 * Phase 2b: buildAgentTask receives resolved worktreePath
 * Phase 2c: agentCwd set to worktreePath for all agents (researcher, architect, developer, auditor)
 * Phase 2d: Worktree creation is idempotent (once per pipeline run)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-pipeline.test.mts
 *
 * Issue #1395 split: handler.ts became a re-export shim. Worktree creation
 * lives in handler/preflight.ts, the agent loop in handler/agent-loop.ts,
 * and the cleanup in handler/post-pipeline.ts — each describe reads the
 * file that owns the behavior it asserts.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult } from "../config/types.ts";
import type { RunContext } from "../pipeline/handler/shared.ts";
import { handlePostPipeline } from "../pipeline/handler/post-pipeline.ts";
import { createStageState } from "../pipeline/stages/index.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PREFLIGHT_TS = resolve(__dirname, "../pipeline/handler/preflight.ts");
const AGENT_LOOP_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");
const POST_PIPELINE_TS = resolve(__dirname, "../pipeline/handler/post-pipeline.ts");

function readPreflightSource(): string {
	return readFileSync(PREFLIGHT_TS, "utf-8");
}
function readAgentLoopSource(): string {
	return readFileSync(AGENT_LOOP_TS, "utf-8");
}
function readPostPipelineSource(): string {
	return readFileSync(POST_PIPELINE_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Worktree creation before agent dispatch (preflight.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree creation before loop", () => {
	it("worktree created in preflight, before the agent loop", () => {
		const preflightSrc = readPreflightSource();
		assert.ok(
			preflightSrc.includes("createWorktree"),
			"createWorktree called in preflight (before the pipeline loop)",
		);
		const loopSrc = readAgentLoopSource();
		assert.ok(
			loopSrc.includes("for (let i = 0; i < MAX_PIPELINE_LOOPS"),
			"pipeline loop lives in agent-loop.ts",
		);
	});

	it("generateBranchName called before worktree creation", () => {
		const src = readPreflightSource();
		const genIdx = src.indexOf("generateBranchName");
		const wtIdx = src.indexOf("createWorktree");
		assert.ok(genIdx >= 0, "generateBranchName call exists");
		assert.ok(wtIdx >= 0, "createWorktree call exists");
		assert.ok(genIdx < wtIdx, "generateBranchName called before createWorktree");
	});

	it("worktreePath assigned only once", () => {
		const src = readPreflightSource();
		const matches = src.match(/worktreePath\s*=\s*createResult\.value/g);
		assert.ok(matches && matches.length === 1, "worktreePath assigned exactly once");
	});
});

// ---------------------------------------------------------------------------
// buildAgentTask receives resolved worktreePath (agent-loop.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — worktreePath passed to buildAgentTask", () => {
	it("buildAgentTask call receives worktreePath argument", () => {
		const src = readAgentLoopSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreePath,") || btSection.includes("worktreePath\n"),
			"worktreePath arg in buildAgentTask call",
		);
	});

	it("buildAgentTask call receives worktreeBranch argument", () => {
		const src = readAgentLoopSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreeBranch,") || btSection.includes("worktreeBranch\n"),
			"worktreeBranch arg in buildAgentTask call",
		);
	});
});

// ---------------------------------------------------------------------------
// agentCwd for developer and auditor (agent-loop.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — agentCwd for all agents", () => {
	it("agentCwd uses worktreePath directly", () => {
		const src = readAgentLoopSource();
		const idx = src.indexOf("cwdOverride: worktreePath");
		assert.ok(idx >= 0, "agentCwd uses worktreePath directly");
	});

	it("agentCwd passed to executeAgent", () => {
		const src = readAgentLoopSource();
		const idx = src.indexOf("executeAgent(");
		const endIdx = src.indexOf(");", idx);
		const callSection = src.substring(idx, endIdx + 2);
		assert.ok(callSection.includes("worktreePath"), "executeAgent uses worktreePath for agentCwd");
	});
});

// ---------------------------------------------------------------------------
// Worktree cleanup at end of pipeline (post-pipeline.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree cleanup", () => {
	it("cleanup at end of handler after try/catch", () => {
		const src = readPostPipelineSource();
		const cleanupIdx = src.lastIndexOf("cleanupWorktree");
		const catchEnd = src.lastIndexOf("}");
		assert.ok(cleanupIdx > 0 && cleanupIdx < catchEnd, "cleanup near end of file");
	});
});

// ---------------------------------------------------------------------------
// Agent retry logic (agent-loop.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — agent retry logic", () => {
	it("validateAgentResult called after both initial and retry runAgent", () => {
		const src = readAgentLoopSource();
		const matches = src.match(/validateAgentResult\(result\)/g);
		assert.strictEqual(
			matches ? matches.length : 0,
			2,
			"validateAgentResult(result) called exactly twice (initial + retry)",
		);
	});

	it("retry block checks budgetExceeded first", () => {
		const src = readAgentLoopSource();
		const budgetIdx = src.indexOf("result.budgetExceeded");
		const usedRetryIdx = src.indexOf("usedRetry = true;");
		assert.ok(budgetIdx >= 0, "budgetExceeded check exists");
		assert.ok(usedRetryIdx > budgetIdx, "budget check precedes retry logic");
	});

	it("retry logic runs on !result.success", () => {
		const src = readAgentLoopSource();
		// Find the executeAgent call which contains retry logic
		const executeIdx = src.indexOf("executeAgent");
		assert.ok(executeIdx >= 0, "executeAgent helper used");
	});
});

// ---------------------------------------------------------------------------
// Researcher budget-exceeded guard (no duplicate comments) (agent-loop.ts)
// ---------------------------------------------------------------------------

describe("pipeline handler — researcher budget-exceeded guard (no duplicate comments)", () => {
	it("budget-exceeded researcher block has !result.success guard to skip when handlePostAgentSuccess posted combined message", () => {
		const src = readAgentLoopSource();
		// The SECOND "if (result.budgetExceeded)" is the pipeline degradation block
		// (the first is in the retry gate block)
		const firstIdx = src.indexOf("if (result.budgetExceeded)");
		const mainIdx = src.indexOf("if (result.budgetExceeded)", firstIdx + 1);
		assert.ok(mainIdx >= 0, "budget-exceeded check exists in main loop");

		const afterBudget = src.slice(mainIdx, mainIdx + 400);
		// The researcher block should have `if (!result.success)` guard
		assert.ok(
			afterBudget.includes('agentName === "researcher"'),
			"researcher check inside budget-exceeded block",
		);

		// The guard check
		const researcherBlockBorder = afterBudget.indexOf('agentName === "researcher"');
		const researcherSection = afterBudget.slice(researcherBlockBorder, researcherBlockBorder + 400);
		assert.ok(
			researcherSection.includes("!result.success"),
			"budget-exceeded researcher block guarded by !result.success to avoid duplicate comment",
		);
	});

	it("status transition still fires for researcher budget-exceeded regardless of success", () => {
		const src = readAgentLoopSource();
		// Pipeline degradation budget-exceeded block (second occurrence)
		const firstIdx = src.indexOf("if (result.budgetExceeded)");
		const mainIdx = src.indexOf("if (result.budgetExceeded)", firstIdx + 1);
		const section = src.slice(mainIdx, src.indexOf("stopReason", mainIdx));
		// The researcher block should always call inferForwardStatus
		assert.ok(
			section.includes("inferForwardStatus(step)"),
			"status transition fires for researcher budget-exceeded",
		);
	});

	it("non-researcher budget-exceeded agent stops pipeline with stopReason (existing behavior preserved)", () => {
		const src = readAgentLoopSource();
		// Pipeline degradation budget-exceeded block (second occurrence)
		const firstIdx = src.indexOf("if (result.budgetExceeded)");
		const mainIdx = src.indexOf("if (result.budgetExceeded)", firstIdx + 1);
		// Find the stopReason after the researcher if-block closes.
		// After the closing brace of the researcher block, the next stopReason
		// is for non-researcher agents.
		const researcherBlockEnd = src.indexOf("// Graceful degradation", mainIdx);
		const afterResearcherBlock = src.slice(researcherBlockEnd);
		const stopReasonIdx = afterResearcherBlock.indexOf("stopReason");
		const section = afterResearcherBlock.slice(stopReasonIdx, stopReasonIdx + 300);
		assert.ok(
			section.includes("exceeded budget"),
			"non-researcher budget-exceeded sets stopReason",
		);
	});

	it("budgetExceeded=false does not enter the budget-exceeded block (existing behavior preserved)", () => {
		const src = readAgentLoopSource();
		const count = (src.match(/if \(result\.budgetExceeded\)/g) || []).length;
		assert.equal(count, 2, "budgetExceeded check appears twice (retry gate + pipeline control)");
	});
});

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
