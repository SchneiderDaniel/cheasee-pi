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
import type { SupervisorConfig, AgentRunResult, PrConflictInfo } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";

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
