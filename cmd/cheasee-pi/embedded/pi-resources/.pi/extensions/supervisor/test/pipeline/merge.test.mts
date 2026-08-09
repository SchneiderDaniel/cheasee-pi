// ─── Tests: pipeline/merge.ts — handlePostPipelineMerge path resolution ───
// Tests that worktreePath parameter is used correctly (no string concat bug).
// Mocks pi.exec and ctx.ui to simulate conflict detection → auto-merge flow.
//
// For the subprocess dispatch path, handlePostPipelineMerge accepts
// an optional _runner parameter (last arg) for injecting a mock
// runAgentSubprocess, avoiding real process spawn.
//
// Temp worktrees are created when tests need merge.ts to find the
// developer agent file (parseAgentFile requires a real file on disk).

import { describe, it, beforeEach, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	AgentRunResult,
	PrConflictInfo,
	PrCreationResult,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

// ─── Temp worktree helper ─────────────────────────────────────────
// merge.ts checks if .pi/extensions/supervisor/agents/developer.md
// exists and parses it via parseAgentFile (uses readFileSync). We must
// create a real file so the code path reaches our mock runner.

const AGENT_FILE_CONTENT = `---
name: developer
description: Test developer agent
tools: read,bash,write,edit
model: test-model
extensions: ""
skills: ""
thinking: medium
---

You are a test developer agent.
`;

function createTempWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "merge-wt-"));
	const agentDir = resolve(dir, ".pi/extensions/supervisor/agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(resolve(agentDir, "developer.md"), AGENT_FILE_CONTENT, "utf-8");
	return dir;
}

// ─── State ────────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];
const tempDirs: string[] = [];

beforeEach(() => {
	widgetCalls = [];
});

afterEach(() => {
	mock.restoreAll();
	for (const d of tempDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	tempDirs.length = 0;
});

// ─── Mock Helpers ──────────────────────────────────────────────────

function makeConflictInfo(hasConflict: boolean): PrConflictInfo {
	return {
		number: 123,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-foo-issue",
		baseRefName: "main",
	};
}

function createMockMergePort(hasConflict: boolean = true): GitHubPort {
	return createMockGitHubPort({
		listPullRequestsForBranch: async () => makeConflictInfo(hasConflict),
	});
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

function createMockCtx(
	confirmResult: boolean = true,
): ExtensionCommandContext & { setWidgetCalls: Array<{ id: string; lines?: string[] }> } {
	const setWidgetCalls: Array<{ id: string; lines?: string[] }> = [];
	return {
		cwd: "/repo",
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: (id: string, lines?: string[]) => {
				setWidgetCalls.push({ id, lines });
			},
			confirm: async () => confirmResult,
		},
		setWidgetCalls,
	} as unknown as ExtensionCommandContext & {
		setWidgetCalls: Array<{ id: string; lines?: string[] }>;
	};
}

// ─── Fixtures ──────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return {
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
		...overrides,
	} as SupervisorConfig;
}

function prListResult(hasConflict: boolean): string {
	return JSON.stringify([
		{
			number: 123,
			mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
			mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
			headRefName: "worktree-git-issue-42-foo-issue",
			baseRefName: "main",
		},
	]);
}

const BRANCH = "worktree-git-issue-42-foo-issue";

// ─── Tests ─────────────────────────────────────────────────────────

describe("handlePostPipelineMerge() — worktree path resolution", () => {
	it("uses worktreePath when provided (7th param)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig();
		const explicitWorktreePath = `/repo/worktrees/${BRANCH}`;

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, explicitWorktreePath, undefined, undefined, createMockMergePort(true));

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		assert.equal(
			fetchCall!.opts.cwd,
			explicitWorktreePath,
			"git fetch cwd should equal the provided worktreePath",
		);
	});

	it("falls back to resolvePath(cwd, worktreeBase, branch) when worktreePath is undefined", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig();

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, undefined, undefined, undefined, createMockMergePort(true));

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/worktrees/${BRANCH}`;
		assert.equal(
			fetchCall!.opts.cwd,
			expectedPath,
			"git fetch cwd should equal resolvePath(cwd, worktreeBase, branch) fallback",
		);
	});

	it("handles worktreeBase without trailing separator correctly (no concat bug)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "../worktrees" });

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, undefined, undefined, undefined, createMockMergePort(true));

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/worktrees/${BRANCH}`;
		const brokenPath = `/worktrees${BRANCH}`;
		assert.notEqual(fetchCall!.opts.cwd, brokenPath, "should NOT use broken string concat");
		assert.equal(fetchCall!.opts.cwd, expectedPath, "should use resolvePath-normalized path");
	});

	it("handles absolute worktreeBase correctly", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "/tmp/worktrees" });

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, undefined, undefined, undefined, createMockMergePort(true));

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/tmp/worktrees/${BRANCH}`;
		assert.equal(fetchCall!.opts.cwd, expectedPath, "should handle absolute worktreeBase");
	});

	it("uses worktreePath with trailing-slash base correctly", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "../worktrees/" });
		const explicitWorktreePath = `/repo/worktrees/${BRANCH}`;

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, explicitWorktreePath, undefined, undefined, createMockMergePort(true));

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		assert.equal(fetchCall!.opts.cwd, explicitWorktreePath, "worktreePath takes precedence");
	});

	it("signature accepts 6 or 7 parameters without breaking existing callers", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(true);
		const config = makeConfig();

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		// No exec calls — conflict check is via port
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, undefined, undefined, undefined, createMockMergePort(false));

		// No exec calls should be made since no conflict and no auto-merge
		assert.equal(calls.length, 0, "no exec calls when no conflict");
	});

	it("does not call tryAutoMerge when user declines", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(false);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", makeConfig(), pi, ctx, undefined, undefined, undefined, createMockMergePort(true));

		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 0, "no git calls when user declines merge");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Subprocess dispatch path tests (replaces former executeTool assertions)
// ═══════════════════════════════════════════════════════════════════

describe("handlePostPipelineMerge() — runAgentSubprocess dispatch", () => {
	/**
	 * Creates mock pi with auto-merge failure sequence:
	 * 1. PR check — conflict detected
	 * 2. git fetch — success
	 * 3. git merge — FAILS (code 1)
	 * 4. git diff --name-only --diff-filter=U — returns conflicted files
	 * 5. git merge --abort — success
	 */
	function createPiWithFailedMerge(execCalls: ExecCall[]) {
		return createMockPi(
			[
				// PR conflict check is via port now, so no gh exec mock needed
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
	}

	function createMockRunner(result?: Partial<AgentRunResult>) {
		return mock.fn(
			async (..._args: any[]) =>
				({
					output: "Conflicts resolved",
					success: true,
					agentName: "developer",
					toolCount: 5,
					tokenCount: 1000,
					durationMs: 30000,
					textOutput: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
					textOnly: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
					summaryLine: "Successfully resolved merge conflicts",
					errorOutput: "",
					...(result || {}),
				}) as AgentRunResult,
		);
	}

	it("calls runAgentSubprocess when auto-merge fails", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
		);

		assert.ok(
			runner.mock.callCount() > 0,
			"runAgentSubprocess should be called when auto-merge fails",
		);
	});

	it("dispatches developer agent for conflict resolution", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
		);

		const devCalls = runner.mock.calls.filter((c) => c.arguments[0]?.config?.name === "developer");
		assert.ok(devCalls.length > 0, "runAgentSubprocess should be called with developer agent");
	});

	it("passes correct params (cwd, maxToolCalls, agentTokenBudget)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const config = makeConfig({ maxToolCalls: 100, agentTokenBudget: 50000 });
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const runner = createMockRunner();
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, wt, undefined, runner, createMockMergePort(true));

		assert.ok(runner.mock.callCount() > 0, "should have runAgentSubprocess calls");
		const args = runner.mock.calls[0]?.arguments;
		assert.ok(args, "should have arguments");
		assert.equal(args[4], wt, "cwd should be worktree path");
		assert.equal(args[5], 100, "maxToolCalls should be passed through");
		assert.equal(args[6], 50000, "agentTokenBudget should be passed through");
	});

	it("task includes merge conflict resolution instructions", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
		);

		assert.ok(runner.mock.callCount() > 0, "should have runAgentSubprocess calls");
		const task = runner.mock.calls[0]?.arguments[1];
		assert.ok(typeof task === "string", "task should be a string");
		assert.ok(task.includes("Resolve Merge Conflicts"), "task should mention merge conflicts");
		assert.ok(task.includes("file1.ts"), "task should mention conflicted files");
		assert.ok(task.includes("CONFLICTS_RESOLVED"), "task should include completion marker");
	});

	it("finally block clears agent-developer widget", async () => {
		const execCalls: ExecCall[] = [];
		const ctx = createMockCtx(true);
		const pi = createPiWithFailedMerge(execCalls);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
		);

		const clearCalls = (ctx as any).setWidgetCalls.filter(
			(w: { id: string; lines?: string[] }) => w.id === "agent-developer" && w.lines === undefined,
		);
		assert.ok(clearCalls.length > 0, "agent-developer widget should be cleared in finally block");
	});

	it("widget is cleared even when runAgentSubprocess throws", async () => {
		const execCalls: ExecCall[] = [];
		const ctx = createMockCtx(true);
		const runner = mock.fn(async () => {
			throw new Error("Subprocess execution failed");
		});
		const pi = createPiWithFailedMerge(execCalls);
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
		);

		const clearCalls = (ctx as any).setWidgetCalls.filter(
			(w: { id: string; lines?: string[] }) => w.id === "agent-developer" && w.lines === undefined,
		);
		assert.ok(
			clearCalls.length > 0,
			"agent-developer widget should be cleared even when runAgentSubprocess throws",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Issue #1472: pre-Done PR readiness gate + mergeability poll

function createGateMockRunner(result?: Partial<AgentRunResult>) {
	return mock.fn(
		async (..._args: any[]) =>
			({
				output: "Conflicts resolved",
				success: true,
				agentName: "developer",
				toolCount: 5,
				tokenCount: 1000,
				durationMs: 30000,
				textOutput: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
				textOnly: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
				summaryLine: "Successfully resolved merge conflicts",
				errorOutput: "",
				...(result || {}),
			}) as AgentRunResult,
	);
}


// ═══════════════════════════════════════════════════════════════════

function makeDirtyInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: true,
		mergeable: "NOT_MERGEABLE",
		mergeStateStatus: "DIRTY",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeCleanInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeUnknownInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: false,
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

// Sequenced listPullRequestsForBranch: returns listValues[i], then repeats
// the last value. Records every port call in trackCalls for order assertions.
function createSequencedPort(
	listValues: Array<PrConflictInfo | null>,
	trackCalls?: PortCall[],
): GitHubPort {
	let idx = 0;
	return createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async (_branch: string, _repo: string) => {
				const v = listValues[Math.min(idx, listValues.length - 1)] ?? null;
				idx++;
				return v;
			},
			createPullRequest: async () => ({ number: 456 }),
			updatePullRequest: async () => {},
			postIssueComment: async () => {},
		},
		trackCalls,
	);
}

function makeFailedPrResult(rebaseConflicts?: string[]): PrCreationResult {
	return {
		success: false,
		error: "Rebase conflicts in 1 file(s)",
		source: "pr-creation",
		pushSkipped: true,
		...(rebaseConflicts ? { rebaseConflicts } : {}),
	};
}

// ─── awaitPrMergeability ───────────────────────────────────────────

describe("awaitPrMergeability() — bounded mergeability poll", () => {
	const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };

	it("returns settled info on the first poll (1 port call)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort([makeCleanInfo()], calls);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.ok(info, "should return settled info");
		assert.equal(info!.hasConflict, false);
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			1,
			"exactly 1 port call when first poll settles",
		);
	});

	it("polls unknown → unknown → clean (exactly 3 polls)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort([makeUnknownInfo(), makeUnknownInfo(), makeCleanInfo()], calls);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.ok(info, "should settle on the 3rd poll");
		assert.equal(info!.mergeStateStatus, "CLEAN");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 3, "exactly 3 polls for unknown → unknown → clean");
	});

	it("all 5 attempts UNKNOWN → returns null (bounded, no hang)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[makeUnknownInfo(), makeUnknownInfo(), makeUnknownInfo(), makeUnknownInfo(), makeUnknownInfo()],
			calls,
		);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.equal(info, null, "null on poll exhaustion");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 5, "exactly 5 polls before exhaustion");
	});

	it("port throws → returns null (fail-open, no crash)", async () => {
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => {
				throw new Error("network error");
			},
		});
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);
		assert.equal(info, null, "fail-open on port error");
	});
});

// ─── ensurePrReadyForDone — gate ───────────────────────────────────

describe("ensurePrReadyForDone() — pre-Done readiness gate", () => {
	const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };

	it("existing clean PR → { ok: true }, no resolution, no createPrOnApproval retry", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([makeCleanInfo()], calls);
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "clean PR passes the gate");
		assert.equal(execCalls.length, 0, "no git calls for a clean PR");
		assert.equal(runner.mock.callCount(), 0, "no developer dispatch for a clean PR");
		assert.ok(
			calls.some((c) => c.method === "listPullRequestsForBranch"),
			"PR existence/mergeability was checked",
		);
	});

	it("PR dirty (#1457) → auto-merge → push → re-poll clean → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([makeDirtyInfo(), makeDirtyInfo(), makeCleanInfo(), makeCleanInfo()], calls);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 0, stdout: "merge ok", stderr: "" }, // tryAutoMerge merge
				{ code: 0, stdout: "push ok", stderr: "" }, // resolveBranchConflicts push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "dirty PR resolved by auto-merge passes the gate");
		assert.equal(runner.mock.callCount(), 0, "auto-merge success does not dispatch developer");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 4, "initial + settle + re-check + re-settle = 4 polls");
		// Port call order: dirty, dirty (settled), clean, clean (settled)
		assert.equal(listCalls[0]?.args[0], BRANCH);
		// Exec order: fetch → merge → push
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "merge", "push"],
			"auto-merge fetch → merge → push",
		);
	});

	it("PR dirty + auto-merge fails → developer dispatch succeeds → createPrOnApproval retried exactly once → re-poll → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([makeDirtyInfo(), makeDirtyInfo(), null, makeCleanInfo(), makeCleanInfo()], calls);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
				{ code: 0, stdout: "fetch ok", stderr: "" }, // retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // retry push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "dev-resolved dirty PR passes the gate");
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch");
		const createCalls = calls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 1, "createPrOnApproval retried exactly once");
	});

	it("rebaseConflicts + no PR (#1455) → resolution proceeds → developer dispatch → retry → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([null, null, makeCleanInfo(), makeCleanInfo()], calls);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
				{ code: 0, stdout: "fetch ok", stderr: "" }, // retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // retry push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			makeFailedPrResult(["src/a.ts"]),
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "#1455 recovery path passes the gate");
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch");
		assert.equal(
			calls.filter((c) => c.method === "createPullRequest").length,
			1,
			"createPrOnApproval retried once after resolution",
		);
	});

	it("developer fails → { ok: false } + blockerNote mentioning manual intervention; exactly 1 dispatch, no retry loop", async () => {
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([null]);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const runner = createGateMockRunner({ success: false, summaryLine: "Could not resolve" });
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			makeFailedPrResult(["src/a.ts"]),
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, false, "developer failure blocks the gate");
		assert.ok(
			verdict.blockerNote!.includes("Manual intervention"),
			"blockerNote must mention manual intervention",
		);
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch, no retry loop");
		assert.equal(
			execCalls.filter((c) => c.args[0] === "push").length,
			0,
			"no push when resolution failed",
		);
	});

	it("retried createPrOnApproval still returns rebaseConflicts → { ok: false } + blockerNote", async () => {
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([null]);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // resolve: tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // resolve: merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // resolve: diff
				{ code: 0, stdout: "", stderr: "" }, // resolve: merge --abort
				{ code: 0, stdout: "fetch ok", stderr: "" }, // retry: rebase fetch
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // retry: rebase fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // retry: diff
				{ code: 0, stdout: "", stderr: "" }, // retry: rebase --abort
				{ code: 1, stdout: "", stderr: "merge failed" }, // retry: merge fallback fails
				{ code: 0, stdout: "", stderr: "" }, // retry: merge --abort
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			makeFailedPrResult(["src/a.ts"]),
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, false, "still-conflicting retry blocks the gate");
		assert.ok(
			verdict.blockerNote!.includes("manual intervention"),
			"blockerNote must mention manual intervention",
		);
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch (no retry loop)");
	});

	it("poll exhaustion with existing PR (mergeability stays UNKNOWN) → { ok: true } fail-open", async () => {
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([
			makeUnknownInfo(),
			makeUnknownInfo(),
			makeUnknownInfo(),
			makeUnknownInfo(),
			makeUnknownInfo(),
			makeUnknownInfo(),
		]);
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "poll exhaustion fails open (documented false-Done window)");
		assert.equal(execCalls.length, 0, "no git calls on poll exhaustion");
		assert.equal(runner.mock.callCount(), 0, "no developer dispatch on poll exhaustion");
	});
});

// ─── handlePostPipelineMerge — rebaseConflicts (no-PR) backstop ────

describe("handlePostPipelineMerge() — rebaseConflicts (#1455 no-PR) backstop", () => {
	it("no rebaseConflicts + no PR → unchanged 'No PR found' early return (regression)", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi([], execCalls);
		const ctx = createMockCtx(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(result, false, "early return, no conflict work");
		assert.equal(execCalls.length, 0, "no git calls when no PR and no rebaseConflicts");
	});

	it("no PR + rebaseConflicts set → skips early return, proceeds to resolution", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
			["src/a.ts"],
		);

		assert.equal(result, false, "resolution succeeded → no unresolved conflicts");
		assert.equal(runner.mock.callCount(), 1, "developer dispatched for #1455 resolution");
		const fetchCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args[0] === "fetch",
		);
		assert.ok(fetchCalls.length > 0, "auto-merge fetch ran — early return was skipped");
	});

	it("no PR + rebaseConflicts + developer fails → returns true (unresolved)", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const runner = createGateMockRunner({ success: false, summaryLine: "Failed" });
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
			["src/a.ts"],
		);

		assert.equal(result, true, "unresolved conflicts reported when developer fails");
	});
});
