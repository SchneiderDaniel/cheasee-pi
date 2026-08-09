// ─── Tests: pipeline/rebase.ts — tryRebaseOntoBase ─────────────────
// Unit tests for the rebase-before-push adapter. Mirrors the mock
// pattern from test/pipeline/merge.test.mts and test/pipeline/pr-creation.test.mts.

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tryRebaseOntoBase } from "../../pipeline/rebase.ts";
import type { RebaseOptions } from "../../config/types.ts";

// ─── Call Tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI with controllable exec responses.
 * By default (reject mode) a non-zero result makes pi.exec reject
 * (simulating a throw) — real pi.exec resolves {code, stdout, stderr}
 * even on non-zero, so collision tests pass `resolveOnError: true`.
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
	options?: { resolveOnError?: boolean },
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++];
			if (!result || (result.code !== 0 && !options?.resolveOnError)) {
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

/** Exact git 2.39.5 stderr for the untracked-file checkout collision (issue #1438 fixture). */
const ISSUE_COLLISION_STDERR = `error: The following untracked working tree files would be overwritten by checkout:
\treport/jscpd-report.json
Please move or remove them before you switch branches.
Aborting
error: could not detach HEAD`;

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
		assert.ok(
			result.message.includes("rebase crashed"),
			"message should surface the thrown error text",
		);

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
				{ code: 1, stdout: "", stderr: "fatal: Unable to create '/workspaces/main/.git/index.lock': File exists." },
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
			result.message.includes("index.lock"),
			"message should surface the real rebase stderr, not a generic fallback",
		);
		assert.ok(
			!result.message.includes("no conflict files"),
			"message should not use the misleading generic fallback when stderr is available",
		);

		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should be called");
	});

	it("Failure message truncates long rebase stderr to ~500 chars for UI notify", async () => {
		const execCalls: ExecCall[] = [];
		const longStderr = "fatal: could not unpack object".padEnd(1200, ".");
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails with long non-collision stderr
				{ code: 1, stdout: "", stderr: longStderr },
				// diff --diff-filter=U returns no files
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		assert.ok(result.message.length <= 520, "message should be bounded (~500 chars)");
		assert.ok(
			result.message.includes(longStderr.slice(0, 80)),
			"message should contain the stderr prefix",
		);
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

	it("Untracked collision: detects colliding paths, scoped clean, retry rebase succeeds", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails with the exact issue stderr (checkout-block, not a conflict)
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				// ls-files --others --exclude-standard
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				// ls-tree -r --name-only origin/main
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				// clean -fd -- report/jscpd-report.json
				{ code: 0, stdout: "", stderr: "" },
				// rebase retry — succeeds
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed after cleanup + retry");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.equal(
			result.message,
			"Rebase succeeded after removing 1 untracked artifact(s) blocking checkout: report/jscpd-report.json",
			"success message should name the removed artifact",
		);
		assert.ok(
			!result.message.includes("no conflict files"),
			"must not fall into the misleading generic message",
		);

		// call order: fetch → rebase → ls-files → ls-tree → clean → rebase retry
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "rebase", "ls-files", "ls-tree", "clean", "rebase"],
			"call order should be fetch, rebase, ls-files, ls-tree, clean, rebase retry",
		);
		// clean args exactly scoped — never a bare `git clean -fd`
		assert.deepEqual(execCalls[4].args, ["clean", "-fd", "--", "report/jscpd-report.json"]);
		assert.equal(execCalls[4].opts.cwd, WORKTREE_PATH, "clean should run in worktree cwd");
	});

	it("Untracked collision: non-colliding untracked files are never cleaned", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				// ls-files lists colliding AND non-colliding untracked files
				{
					code: 0,
					stdout: "report/jscpd-report.json\nscratch/notes.txt\n",
					stderr: "",
				},
				// ls-tree only tracks the colliding path
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed");
		assert.deepEqual(
			execCalls[4].args,
			["clean", "-fd", "--", "report/jscpd-report.json"],
			"clean should receive ONLY the intersection path, not scratch/notes.txt",
		);
	});

	it("Untracked collision: multiple collisions cleaned, success message lists both", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				{
					code: 0,
					stdout: "report/jscpd-report.json\ndist/bundle.js\n",
					stderr: "",
				},
				{
					code: 0,
					stdout: "report/jscpd-report.json\ndist/bundle.js\n",
					stderr: "",
				},
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "should succeed");
		assert.deepEqual(
			execCalls[4].args,
			["clean", "-fd", "--", "report/jscpd-report.json", "dist/bundle.js"],
			"clean should receive both colliding paths",
		);
		assert.equal(
			result.message,
			"Rebase succeeded after removing 2 untracked artifact(s) blocking checkout: report/jscpd-report.json, dist/bundle.js",
			"message should list both artifacts with correct count",
		);
	});

	it("Untracked collision pattern but nothing untracked: no clean, no retry, falls through to diff/abort", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				// ls-files finds nothing untracked
				{ code: 0, stdout: "", stderr: "" },
				// ls-tree still lists the path
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				// diff --diff-filter=U empty
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		assert.ok(
			result.message.includes("untracked working tree files would be overwritten"),
			"failure message should be stderr-backed",
		);
		const cleanCalls = execCalls.filter((c) => c.args[0] === "clean");
		assert.equal(cleanCalls.length, 0, "no clean call when nothing untracked");
		const rebaseCalls = execCalls.filter(
			(c) => c.args[0] === "rebase" && c.args[1] !== "--abort",
		);
		assert.equal(rebaseCalls.length, 1, "no retry when nothing untracked");
	});

	it("Untracked collision: clean succeeds but retry rebase fails → exactly one retry, falls through", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				// rebase retry fails for a DIFFERENT reason
				{ code: 1, stdout: "", stderr: "fatal: could not apply patch" },
				// diff --diff-filter=U empty
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail when retry also fails");
		assert.deepEqual(result.conflictFiles, [], "should have no conflict files");
		assert.ok(
			result.message.includes("could not apply patch"),
			"message should surface the retry failure stderr",
		);
		const rebaseCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] !== "--abort");
		assert.equal(rebaseCalls.length, 2, "rebase should be invoked exactly twice (one retry)");
		// falls through to diff → abort
		assert.equal(execCalls[6].args[0], "diff");
		assert.equal(execCalls[7].args[0], "rebase");
		assert.equal(execCalls[7].args[1], "--abort");
	});

	it("Untracked collision: ls-files exec rejects → fail-closed, no clean, no retry", async () => {
		const execCalls: ExecCall[] = [];
		let callCount = 0;
		const pi: ExtensionAPI = {
			exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
				execCalls.push({ cmd, args: args || [], opts: opts || {} });
				callCount++;
				if (callCount === 1) {
					return Promise.resolve({ code: 0, stdout: "fetch ok", stderr: "" });
				}
				if (callCount === 2) {
					return Promise.resolve({ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR });
				}
				if (callCount === 3) {
					return Promise.reject(new Error("ls-files failed: fatal"));
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
			registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
			sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
		} as ExtensionAPI;

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail closed");
		assert.deepEqual(result.conflictFiles, [], "no partial success");
		assert.ok(
			result.message.includes("untracked working tree files would be overwritten"),
			"message should be backed by the rebase stderr",
		);
		const cleanCalls = execCalls.filter((c) => c.args[0] === "clean");
		assert.equal(cleanCalls.length, 0, "no clean call when detection failed");
		const rebaseCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] !== "--abort");
		assert.equal(rebaseCalls.length, 1, "no retry when detection failed");
	});

	it("Untracked collision: ls-tree exec rejects → fail-closed, no clean, no retry", async () => {
		const execCalls: ExecCall[] = [];
		let callCount = 0;
		const pi: ExtensionAPI = {
			exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
				execCalls.push({ cmd, args: args || [], opts: opts || {} });
				callCount++;
				if (callCount === 1) {
					return Promise.resolve({ code: 0, stdout: "fetch ok", stderr: "" });
				}
				if (callCount === 2) {
					return Promise.resolve({ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR });
				}
				if (callCount === 3) {
					return Promise.resolve({ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" });
				}
				if (callCount === 4) {
					return Promise.reject(new Error("ls-tree failed: fatal"));
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
			registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
			sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
		} as ExtensionAPI;

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail closed");
		assert.ok(
			result.message.includes("untracked working tree files would be overwritten"),
			"message should be backed by the rebase stderr",
		);
		const cleanCalls = execCalls.filter((c) => c.args[0] === "clean");
		assert.equal(cleanCalls.length, 0, "no clean call when detection failed");
	});

	it("Untracked collision: clean exec fails (code≠0) → no retry, falls through to diff/abort", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				// clean fails
				{ code: 1, stdout: "", stderr: "fatal: clean failed" },
				// diff empty
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(!result.success, "should fail");
		assert.ok(
			result.message.includes("untracked working tree files would be overwritten"),
			"message should be stderr-backed",
		);
		const rebaseCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] !== "--abort");
		assert.equal(rebaseCalls.length, 1, "no retry when clean failed (state unknown)");
		// falls through to diff → abort
		assert.equal(execCalls[5].args[0], "diff");
		assert.equal(execCalls[6].args[0], "rebase");
		assert.equal(execCalls[6].args[1], "--abort");
	});

	// ─── Phase 1 (issue #1473): mergeFallback:false option ──────────

	it("mergeFallback:false + conflict → conflictFiles returned, merge NEVER invoked, abort exactly once", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// rebase fails with a conflict
				{ code: 1, stdout: "", stderr: "rebase failed: conflict" },
				// diff --diff-filter=U lists conflicted files
				{ code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" },
				// rebase --abort succeeds
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(!result.success, "should fail on conflict");
		assert.deepEqual(
			result.conflictFiles,
			["src/a.ts", "src/b.ts"],
			"should return conflicted files straight after abort",
		);
		assert.ok(
			result.message.includes("Rebase conflicts"),
			"message should mention rebase conflicts",
		);

		// git merge --no-edit NEVER invoked; no git merge --abort (nothing to abort)
		const mergeCalls = execCalls.filter((c) => c.args[0] === "merge");
		assert.equal(mergeCalls.length, 0, "merge fallback must NOT be invoked with mergeFallback:false");
		// git rebase --abort called exactly once
		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should be called exactly once");
		// call order: fetch → rebase → diff → abort
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "rebase", "diff", "rebase"],
			"call order should be fetch, rebase, diff, rebase --abort",
		);
	});

	it("opts undefined (default) → merge fallback still attempted on conflict (regression guard)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rebase failed: conflict" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				// merge fallback — succeeds
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi);

		assert.ok(result.success, "default opts should still attempt and succeed via merge fallback");
		assert.deepEqual(result.conflictFiles, []);
		const mergeCalls = execCalls.filter((c) => c.args[0] === "merge");
		assert.equal(mergeCalls.length, 1, "default opts must still attempt the merge fallback");
		assert.deepEqual(mergeCalls[0]!.args, ["merge", "--no-edit", "origin/main"]);
	});

	it("mergeFallback:false + success → call sequence identical to default (fetch → rebase)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(result.success, "should succeed");
		assert.deepEqual(result.conflictFiles, [], "no conflict files on success");
		assert.equal(execCalls.length, 2, "only fetch + rebase");
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "rebase"],
			"option must not alter the success path",
		);
	});

	it("mergeFallback:false + non-conflict failure (index.lock) → abort called, stderr-backed message, empty conflictFiles", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "fatal: Unable to create '/workspaces/main/.git/index.lock': File exists." },
				// diff empty
				{ code: 0, stdout: "", stderr: "" },
				// abort
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(!result.success, "should fail");
		assert.deepEqual(result.conflictFiles, [], "no conflict files");
		assert.ok(
			result.message.includes("index.lock"),
			"message should surface the real rebase stderr",
		);
		const abortCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] === "--abort");
		assert.equal(abortCalls.length, 1, "rebase --abort should be called");
		const mergeCalls = execCalls.filter((c) => c.args[0] === "merge");
		assert.equal(mergeCalls.length, 0, "no merge fallback on non-conflict failure");
	});

	it("mergeFallback:false + fetch exhaustion → unchanged failure, no rebase attempted", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "network down 1" },
				{ code: 1, stdout: "", stderr: "network down 2" },
				{ code: 1, stdout: "", stderr: "network down 3" },
			],
			execCalls,
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(!result.success, "should fail");
		assert.deepEqual(result.conflictFiles, []);
		assert.ok(result.message.toLowerCase().includes("fetch failed"));
		assert.equal(execCalls.length, 3, "all calls are fetch attempts");
		for (const call of execCalls) {
			assert.equal(call.args[0], "fetch");
		}
	});

	it("mergeFallback:false + untracked-collision → Phase 2.5 scoped-clean + retry still applies", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(result.success, "scoped-clean + retry must still apply with mergeFallback:false");
		assert.deepEqual(result.conflictFiles, []);
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "rebase", "ls-files", "ls-tree", "clean", "rebase"],
			"option only gates the post-conflict merge, never the collision recovery",
		);
		assert.deepEqual(execCalls[4].args, ["clean", "-fd", "--", "report/jscpd-report.json"]);
	});

	// ─── Phase 2 (issue #1473): RebaseOptions type contract ─────────

	it("tryRebaseOntoBase accepts optional RebaseOptions as 5th argument (type-level contract)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);
		// Compile-time contract: { mergeFallback: boolean } accepted; unknown keys rejected.
		const opts: RebaseOptions = { mergeFallback: false };
		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, opts);
		assert.ok(result.success);
		const emptyOpts: RebaseOptions = {};
		assert.equal(emptyOpts.mergeFallback, undefined, "mergeFallback is optional");
	});
});
