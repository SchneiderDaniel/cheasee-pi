// ─── Tests: pipeline/merge.ts — handlePostPipelineMerge path resolution ───
// Tests that worktreePath parameter is used correctly (no string concat bug).
// Mocks pi.exec and ctx.ui to simulate conflict detection → auto-merge flow.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import { handlePostPipelineMerge } from "../../pipeline/merge.ts";

// ─── Call tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

// ─── Shared widget tracking ────────────────────────────────────────

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];
let executeToolCalls: Array<{ name: string; params: any }> = [];

beforeEach(() => {
	widgetCalls = [];
	executeToolCalls = [];
});

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI & { executeToolCalls: Array<{ name: string; params: any }> } {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
		executeTool: ((name: string, params: any) => {
			executeToolCalls.push({ name, params });
			// Return success result for developer subagent
			return Promise.resolve({
				content: [{ type: "text", text: "Conflicts resolved" }],
				details: {
					agentName: "developer",
					success: true,
					statusLabel: "SUCCESS",
					summaryLine: "Successfully resolved merge conflicts",
					model: "",
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 0,
					durationMs: 10000,
					toolCalls: [],
					toolResults: [],
					taskPrompt: "",
				},
			});
		}) as any,
	} as unknown as ExtensionAPI & { executeToolCalls: Array<{ name: string; params: any }> };
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

// Helper: generateBranchName slug for "Foo issue" → "foo-issue",
// so the full branch is "worktree-git-issue-42-foo-issue"
const BRANCH = "worktree-git-issue-42-foo-issue";

// ─── Tests ─────────────────────────────────────────────────────────

describe("handlePostPipelineMerge() — worktree path resolution (Phase 1)", () => {
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

		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, explicitWorktreePath);

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

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined, // no worktreePath — fallback
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");

		// resolvePath(ctx.cwd, "../worktrees/", BRANCH)
		// ctx.cwd = /repo, so normalized to /worktrees/<BRANCH>
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
		// worktreeBase WITHOUT trailing slash — the case that was broken
		const config = makeConfig({ worktreeBase: "../worktrees" });

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined, // no worktreePath — fallback
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");

		// resolvePath(ctx.cwd, "../worktrees", BRANCH) = /worktrees/<BRANCH>
		const expectedPath = `/worktrees/${BRANCH}`;
		// Old concat: "../worktrees" + BRANCH = "../worktrees<BRANCH>" → wrong!
		const brokenPath = `/worktrees${BRANCH}`;
		assert.notEqual(
			fetchCall!.opts.cwd,
			brokenPath,
			"should NOT use broken string concat without separator",
		);
		assert.equal(
			fetchCall!.opts.cwd,
			expectedPath,
			"should use resolvePath-normalized path without trailing-slash base",
		);
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

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined, // no worktreePath — fallback
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");

		// resolvePath(ctx.cwd, "/tmp/worktrees", BRANCH) = /tmp/worktrees/<BRANCH>
		const expectedPath = `/tmp/worktrees/${BRANCH}`;
		assert.equal(
			fetchCall!.opts.cwd,
			expectedPath,
			"should handle absolute worktreeBase correctly",
		);
	});

	it("uses worktreePath with trailing-slash base correctly (matches resolvePath)", async () => {
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

		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, explicitWorktreePath);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		assert.equal(
			fetchCall!.opts.cwd,
			explicitWorktreePath,
			"worktreePath should take precedence over worktreeBase config",
		);
	});

	it("signature accepts 6 or 7 parameters without breaking existing callers", async () => {
		// Verify the function accepts 6 params (old signature) — backward compat
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: prListResult(false), stderr: "" }], calls);
		const ctx = createMockCtx(true);
		const config = makeConfig();

		// Call with 6 params (old signature)
		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx);

		// gh client may use "gh" or "bash" cmd depending on GH_TOKEN presence
		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCalls.length > 0, "should have checked for conflicts");
	});

	it("does not call tryAutoMerge when user declines", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: prListResult(true), stderr: "" }], calls);
		const ctx = createMockCtx(false); // user declines

		await handlePostPipelineMerge(42, "Foo issue", "Done", makeConfig(), pi, ctx, undefined);

		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 0, "no git calls when user declines merge");
	});
});

// ═══════════════════════════════════════════════════════════════════
// ExecuteSubagent path tests (Phase 4 — Audit Finding 3)
// ═══════════════════════════════════════════════════════════════════

describe("handlePostPipelineMerge() — executeSubagent dispatch (Phase 4)", () => {
	/**
	 * Helper: creates mock pi with auto-merge failure sequence:
	 * 1. PR check — conflict detected
	 * 2. git fetch — success
	 * 3. git merge — FAILS (code 1)
	 * 4. git diff --name-only --diff-filter=U — returns conflicted files
	 * 5. git merge --abort — success
	 */
	function createPiWithFailedMerge(execCalls: ExecCall[]) {
		return createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
	}

	it("calls pi.executeTool with 'subagent' when auto-merge fails", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		// pi.executeTool should have been called with "subagent"
		const subagentCalls = executeToolCalls.filter((c) => c.name === "subagent");
		assert.ok(subagentCalls.length > 0, "executeTool should be called with 'subagent'");
	});

	it("calls pi.executeTool with agent='developer' for conflict resolution", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		const subagentCalls = executeToolCalls.filter(
			(c) => c.name === "subagent" && c.params?.agent === "developer",
		);
		assert.ok(subagentCalls.length > 0, "executeTool should be called with agent='developer'");
	});

	it("passes correct params to executeTool (cwd, maxToolCalls, agentTokenBudget)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const config = makeConfig({ maxToolCalls: 100, agentTokenBudget: 50000 });
		const wt = "/repo/worktrees/worktree-git-issue-42-foo-issue";

		await handlePostPipelineMerge(42, "Foo issue", "Done", config, pi, ctx, wt);

		const subagentCalls = executeToolCalls.filter((c) => c.name === "subagent");
		assert.ok(subagentCalls.length > 0, "should have executeTool calls");
		const params = subagentCalls[0].params;
		assert.equal(params.agent, "developer", "agent should be developer");
		assert.equal(params.cwd, wt, "cwd should be worktree path");
		assert.equal(params.maxToolCalls, 100, "maxToolCalls should be passed through");
		assert.equal(params.agentTokenBudget, 50000, "agentTokenBudget should be passed through");
	});

	it("passes onUpdate callback in executeTool options", async () => {
		const execCalls: ExecCall[] = [];
		const capturedOpts: Array<{ name: string; params: any; opts: any }> = [];

		// Custom pi that captures onUpdate
		const pi = {
			...createPiWithFailedMerge(execCalls),
			executeTool: ((name: string, params: any, opts?: any) => {
				capturedOpts.push({ name, params, opts });
				// Call onUpdate to verify it's a function
				if (opts?.onUpdate && typeof opts.onUpdate === "function") {
					opts.onUpdate({
						content: [{ type: "text", text: "Running" }],
						details: {
							agentName: "developer",
							phase: "thinking",
							liveThinking: "Resolving conflicts...",
						},
					});
				}
				return Promise.resolve({
					content: [{ type: "text", text: "Resolved" }],
					details: {
						agentName: "developer",
						success: true,
						statusLabel: "SUCCESS",
						summaryLine: "Resolved merge conflicts",
						model: "",
						inputTokens: 0,
						outputTokens: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turnCount: 0,
						durationMs: 10000,
						toolCalls: [],
						toolResults: [],
						taskPrompt: "",
					},
				});
			}) as any,
		};
		const ctx = createMockCtx(true);

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		// onUpdate should be a function
		const subagentOpt = capturedOpts.find((o) => o.name === "subagent");
		assert.ok(subagentOpt, "should have captured subagent executeTool call");
		assert.ok(
			typeof subagentOpt!.opts?.onUpdate === "function",
			"executeTool should receive onUpdate callback",
		);
	});

	it("finally block clears agent-developer widget", async () => {
		const execCalls: ExecCall[] = [];
		const ctx = createMockCtx(true);
		const pi = createPiWithFailedMerge(execCalls);

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		// In the finally block, setWidget is called with 'agent-developer' and undefined
		const clearCalls = (ctx as any).setWidgetCalls.filter(
			(w: { id: string; lines?: string[] }) => w.id === "agent-developer" && w.lines === undefined,
		);
		assert.ok(clearCalls.length > 0, "agent-developer widget should be cleared in finally block");
	});

	it("widget is cleared even when pi.executeTool throws", async () => {
		const execCalls: ExecCall[] = [];
		const ctx = createMockCtx(true);

		// Create pi that throws on executeTool
		const pi = {
			...createPiWithFailedMerge(execCalls),
			executeTool: (() => {
				return Promise.reject(new Error("Subagent execution failed"));
			}) as any,
		};

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		// Widget should still be cleared even after executeTool throws
		const clearCalls = (ctx as any).setWidgetCalls.filter(
			(w: { id: string; lines?: string[] }) => w.id === "agent-developer" && w.lines === undefined,
		);
		assert.ok(
			clearCalls.length > 0,
			"agent-developer widget should be cleared even when executeTool throws",
		);
	});

	it("task includes merge conflict resolution instructions", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);

		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			"/repo/worktrees/worktree-git-issue-42-foo-issue",
		);

		const subagentCalls = executeToolCalls.filter((c) => c.name === "subagent");
		assert.ok(subagentCalls.length > 0, "should have executeTool calls");
		const task = subagentCalls[0].params?.task;
		assert.ok(typeof task === "string", "task should be a string");
		assert.ok(task.includes("Resolve Merge Conflicts"), "task should mention merge conflicts");
		assert.ok(task.includes("file1.ts"), "task should mention conflicted files");
		assert.ok(task.includes("CONFLICTS_RESOLVED"), "task should include completion marker");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Note: Phase 5 (user-journey) test additions are in chat-progress.test.mts
// ═══════════════════════════════════════════════════════════════════
