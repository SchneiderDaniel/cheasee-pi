// ─── Tests: pipeline/rebase.ts — tryRebaseOntoBase ─────────────────
// Unit tests for the rebase-before-push adapter. Mirrors the mock
// pattern from test/pipeline/merge.test.mts and test/pipeline/pr-creation.test.mts.

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tryRebaseOntoBase } from "../../pipeline/rebase.ts";

// ─── Call Tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI with controllable exec responses.
 * If a result.code !== 0, pi.exec rejects (simulating command failure).
 * Otherwise resolves with the result.
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++];
			if (!result || result.code !== 0) {
				const errMsg = result?.stderr || result?.stdout || `Command failed: ${cmd}`;
				return Promise.reject(new Error(errMsg));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const WORKTREE_PATH = "/worktrees/wt-42";
const DEFAULT_BRANCH = "main";
const REMOTE = "origin";

afterEach(() => {
	mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════
// Adapter: tryRebaseOntoBase
// ═══════════════════════════════════════════════════════════════════

describe("tryRebaseOntoBase()", () => {
	it("Happy path: git fetch succeeds → git rebase --autostash succeeds → success", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.ok(result.message, "should have a message");

		// Verify exec call order: fetch → rebase
		assert.equal(execCalls.length, 2, "should have 2 exec calls");
		assert.ok(execCalls[0].args.includes("fetch"), "first call should be git fetch");
		assert.equal(execCalls[0].args[1], REMOTE, "fetch should use correct remote");
		assert.equal(execCalls[0].args[2], DEFAULT_BRANCH, "fetch should use correct branch");
		assert.equal(execCalls[0].opts.cwd, WORKTREE_PATH, "fetch should use worktree cwd");
		assert.equal(execCalls[0].opts.timeout, 60000, "fetch should have 60s timeout");

		assert.ok(execCalls[1].args.includes("rebase"), "second call should be git rebase");
		assert.equal(execCalls[1].args[1], "--autostash", "rebase should use --autostash");
		assert.equal(
			execCalls[1].args[2],
			`${REMOTE}/${DEFAULT_BRANCH}`,
			"rebase should use remote/branch",
		);
		assert.equal(execCalls[1].opts.cwd, WORKTREE_PATH, "rebase should use worktree cwd");
		assert.equal(execCalls[1].opts.timeout, 60000, "rebase should have 60s timeout");
	});

	it("Fetch retry: first fetch fails, second fetch succeeds → rebase proceeds", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// 1. git fetch — FAILS
				{ code: 1, stdout: "", stderr: "fetch failed: network error" },
				// 2. git fetch — succeeds
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 3. git rebase --autostash — succeeds
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed after fetch retry");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");

		// Verify 3 exec calls: fetch (fail) → fetch (succeed) → rebase
		assert.equal(execCalls.length, 3, "should have 3 exec calls");
		assert.equal(execCalls[0].args[0], "fetch", "first call should be git fetch");
		assert.equal(execCalls[1].args[0], "fetch", "second call should be git fetch (retry)");
		assert.equal(execCalls[2].args[0], "rebase", "third call should be git rebase");
	});

	it("Fetch exhaustion: all 3 fetch retries fail → returns failure with fetch error", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// 1. git fetch — FAILS
				{ code: 1, stdout: "", stderr: "fetch failed: network error 1" },
				// 2. git fetch — FAILS
				{ code: 1, stdout: "", stderr: "fetch failed: network error 2" },
				// 3. git fetch — FAILS
				{ code: 1, stdout: "", stderr: "fetch failed: network error 3" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail when all fetch retries exhausted");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.ok(
			result.message.toLowerCase().includes("fetch failed"),
			"message should mention fetch failure",
		);
		assert.ok(result.message.includes("3"), "message should mention retry count");

		// Verify 3 fetch calls, no rebase call
		assert.equal(execCalls.length, 3, "should have 3 exec calls (all fetch)");
		for (const call of execCalls) {
			assert.equal(call.args[0], "fetch", "all calls should be git fetch");
		}
	});

	it("Rebase conflict detected: rebase fails → merge fallback also fails → returns conflictFiles", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rebase failed: conflict" },
				{ code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				// 5. git merge --no-edit origin/main — also fails
				{ code: 1, stdout: "", stderr: "merge failed: conflict" },
				// 6. git merge --abort — succeeds
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail on conflict");
		assert.deepEqual(
			result.conflictFiles,
			["src/a.ts", "src/b.ts"],
			"should return conflicted files",
		);
		assert.ok(
			result.message.includes("Rebase conflicts"),
			"message should mention rebase conflicts",
		);

		// Verify call order: fetch → rebase → diff → abort → merge → merge --abort
		assert.equal(execCalls.length, 6, "should have 6 exec calls");
		assert.equal(execCalls[0].args[0], "fetch");
		assert.equal(execCalls[1].args[0], "rebase");
		assert.equal(execCalls[2].args[0], "diff");
		assert.equal(execCalls[2].args[1], "--name-only");
		assert.equal(execCalls[2].args[2], "--diff-filter=U");
		assert.equal(execCalls[3].args[0], "rebase");
		assert.equal(execCalls[3].args[1], "--abort");
		assert.equal(execCalls[4].args[0], "merge");
		assert.equal(execCalls[4].args[1], "--no-edit");
		assert.equal(execCalls[5].args[0], "merge");
		assert.equal(execCalls[5].args[1], "--abort");
	});

	it("Abort called even when rebase throws (non-git error): catches, runs abort", async () => {
		const execCalls: ExecCall[] = [];
		// First exec (fetch) succeeds, second exec (rebase) throws
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// second call throws — simulate pi.exec crashing
			],
			execCalls,
		);
		// Override the second response: make rebase throw
		let callCount = 0;
		const throwingPi: ExtensionAPI = {
			...pi,
			exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
				execCalls.push({ cmd, args: args || [], opts: opts || {} });
				callCount++;
				if (callCount === 1) {
					return Promise.resolve({ code: 0, stdout: "fetch ok", stderr: "" });
				}
				if (callCount === 2) {
					return Promise.reject(new Error("rebase crashed: out of memory"));
				}
				// For the abort call
				if (callCount === 3) {
					return Promise.resolve({ code: 0, stdout: "", stderr: "" });
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
		};

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, throwingPi);

		assert.ok(!result.success, "should fail when rebase throws");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files (diff skipped)");

		// Verify abort was called
		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should be called");
	});

	it("Autostash flag is used in rebase args", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);

		await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		const rebaseCall = execCalls.find((c) => c.args[0] === "rebase");
		assert.ok(rebaseCall, "rebase should be called");
		assert.ok(rebaseCall!.args.includes("--autostash"), "rebase should include --autostash flag");
		assert.equal(rebaseCall!.args[2], "origin/main", "rebase target should be origin/main");
	});

	it("Conflict file list filters whitespace-only lines", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails
				{ code: 1, stdout: "", stderr: "conflict" },
				// diff output has empty/whitespace lines
				{ code: 0, stdout: "src/a.ts\n   \n\nsrc/b.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				// merge also fails
				{ code: 1, stdout: "", stderr: "merge conflict" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		assert.deepEqual(
			result.conflictFiles,
			["src/a.ts", "src/b.ts"],
			"should filter whitespace-only lines",
		);
	});

	it("No conflicts but rebase fails for other reason (e.g., dirty index without autostash edge): detected, abort called, returns failure", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails (non-conflict)
				{ code: 1, stdout: "", stderr: "rebase failed: could not apply" },
				// diff --diff-filter=U returns no files
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.ok(
			result.message.includes("no conflict files"),
			"message should indicate no conflicts detected",
		);

		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should be called");
	});

	it("Fetch fails: message is user-notify-level (not a shell escape)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 1,
					stdout: "",
					stderr: "fatal: unable to access 'https://github.com/owner/repo.git/'",
				},
				{
					code: 1,
					stdout: "",
					stderr: "fatal: unable to access 'https://github.com/owner/repo.git/'",
				},
				{
					code: 1,
					stdout: "",
					stderr: "fatal: unable to access 'https://github.com/owner/repo.git/'",
				},
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		// Message should be a clean user-facing message, not a thrown exception or raw stderr
		assert.ok(typeof result.message === "string", "message should be a string");
		assert.ok(result.message.length > 0, "message should not be empty");
		assert.ok(!result.message.includes("Error:"), "message should not contain 'Error:' prefix");
	});

	it("Rebase uses correct branch/remote args: git fetch origin main, git rebase --autostash origin/main", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);

		await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.equal(execCalls[0].cmd, "git");
		assert.deepEqual(execCalls[0].args, ["fetch", "origin", "main"]);
		assert.equal(execCalls[0].opts.cwd, WORKTREE_PATH);

		assert.equal(execCalls[1].cmd, "git");
		assert.deepEqual(execCalls[1].args, ["rebase", "--autostash", "origin/main"]);
		assert.equal(execCalls[1].opts.cwd, WORKTREE_PATH);
	});

	it("Conflict detection: diff --diff-filter=U fails → still aborts rebase → returns failure", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails
				{ code: 1, stdout: "", stderr: "conflict" },
				// diff throws
			],
			execCalls,
		);
		let callCount = 0;
		const throwingPi: ExtensionAPI = {
			...pi,
			exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
				execCalls.push({ cmd, args: args || [], opts: opts || {} });
				callCount++;
				if (callCount <= 2) {
					return Promise.resolve({
						code: callCount === 1 ? 0 : 1,
						stdout: "",
						stderr: callCount === 2 ? "conflict" : "",
					});
				}
				if (callCount === 3) {
					// diff throws
					return Promise.reject(new Error("diff failed"));
				}
				// abort
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
		};

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, throwingPi);

		assert.ok(!result.success, "should fail");
		// abort should still be called
		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should still be called");
	});

	it("Rebase conflict: merge fallback succeeds → returns success with no conflictFiles", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rebase failed: conflict" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				// 5. git merge --no-edit origin/main — succeeds (auto-resolved)
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed when merge fallback resolves");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.ok(
			result.message.includes("merge fallback succeeded"),
			"message should mention merge fallback",
		);

		// Verify call order: fetch → rebase → diff → abort → merge
		assert.equal(execCalls.length, 5, "should have 5 exec calls");
		assert.equal(execCalls[0].args[0], "fetch");
		assert.equal(execCalls[1].args[0], "rebase");
		assert.equal(execCalls[2].args[0], "diff");
		assert.equal(execCalls[3].args[0], "rebase");
		assert.equal(execCalls[3].args[1], "--abort");
		assert.equal(execCalls[4].args[0], "merge");
		assert.equal(execCalls[4].args[1], "--no-edit");
	});
});
