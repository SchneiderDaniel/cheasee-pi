import { describe, it, mock, afterEach } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tryRebaseOntoBase } from "../../pipeline/rebase.ts";

import type { RebaseOptions } from "../../config/types.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

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

const WORKTREE_PATH = "/worktrees/wt-42";

const DEFAULT_BRANCH = "main";

const REMOTE = "origin";

const ISSUE_COLLISION_STDERR = `error: The following untracked working tree files would be overwritten by checkout:
\treport/jscpd-report.json
Please move or remove them before you switch branches.
Aborting
error: could not detach HEAD`;

afterEach(() => {
	mock.restoreAll();
});

describe("tryRebaseOntoBase()", () => {
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
		const rebaseCalls = execCalls.filter((c) => c.args[0] === "rebase" && c.args[1] !== "--abort");
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
		assert.equal(
			mergeCalls.length,
			0,
			"merge fallback must NOT be invoked with mergeFallback:false",
		);
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
				{
					code: 1,
					stdout: "",
					stderr: "fatal: Unable to create '/workspaces/main/.git/index.lock': File exists.",
				},
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
});
