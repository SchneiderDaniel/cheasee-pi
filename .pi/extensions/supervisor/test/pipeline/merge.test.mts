// ─── Tests: pipeline/merge.ts — handlePostPipelineMerge path resolution ───
// Tests that worktreePath parameter is used correctly (no string concat bug).
// Mocks pi.exec and ctx.ui to simulate conflict detection → auto-merge flow.

import { describe, it } from "node:test";
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

// ─── Mock Helpers ──────────────────────────────────────────────────

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
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => confirmResult,
		},
	} as unknown as ExtensionCommandContext;
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
