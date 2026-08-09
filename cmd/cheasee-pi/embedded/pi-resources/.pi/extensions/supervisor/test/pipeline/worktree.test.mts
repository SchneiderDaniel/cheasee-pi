// ─── Tests: pipeline/worktree.ts — worktree lifecycle ───────────
// Tests with mock pi.exec. No git operations.
// All functions return Result<T> — tests assert .ok shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createWorktree,
	reconcileToRemoteBranch,
	installWorktreeDeps,
	cleanupWorktree,
	deleteBranch,
} from "../../pipeline/worktree.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

// ─── Helpers ──────────────────────────────────────────────────────

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
			const result = results[idx++] || { code: 0, stdout: "", stderr: "" };
			// Reject on non-zero exit code (matches pi.exec behavior)
			if (result.code !== 0) {
				return Promise.reject(
					new Error(result.stderr || result.stdout || `Command failed: ${cmd}`),
				);
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

/**
 * Create a mock pi.exec that records calls but doesn't execute results in order.
 * Unlike createMockPi, this uses a map of command patterns to results for when
 * you need different responses for different commands (e.g., rev-parse=0 vs fetch=0).
 */
function createMockPiWithDefaults(defaultResult: { code: number; stdout: string; stderr: string }): ExtensionAPI {
	const callLog: ExecCall[] = [];
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = { ...defaultResult };
			if (result.code !== 0) {
				return Promise.reject(
					new Error(result.stderr || result.stdout || `Command failed: ${cmd}`),
				);
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
	} as unknown as ExtensionAPI;
}

function createMockNotify(): { notify: NotifyFn; calls: Array<{ level: string; msg: string }> } {
	const calls: Array<{ level: string; msg: string }> = [];
	const notify: NotifyFn = {
		info: (msg: string) => calls.push({ level: "info", msg }),
		error: (msg: string) => calls.push({ level: "error", msg }),
	};
	return { notify, calls };
}

// ─── Tests: createWorktree() ─────────────────────────────────────

describe("createWorktree()", () => {
	it("creates worktree with -b flag on first attempt — returns { ok: true, value }", async () => {
		const calls: ExecCall[] = [];
		// add succeeds → reconciliation: rev-parse exits 128 (no remote ref)
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await createWorktree(
			pi,
			"/repo",
			"../worktrees",
			"feature-branch",
			"main",
			notify,
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.ok(result.value.includes("feature-branch"));
		}
		assert.deepEqual(calls[0].args, [
			"worktree",
			"add",
			"-b",
			"feature-branch",
			result.ok ? result.value : "",
			"main",
		]);
		// Reconciliation: rev-parse exits 128 → no-op, no fetch/reset
		assert.equal(calls.length, 2, "should have 2 exec calls (add + rev-parse)");
		assert.deepEqual(calls[1].args, ["rev-parse", "--verify", "refs/remotes/origin/feature-branch"]);
	});

	it("falls back to add without -b when first attempt fails — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "already exists" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await createWorktree(
			pi,
			"/repo",
			"../worktrees",
			"feature-branch",
			"main",
			notify,
		);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 3, "should have 3 exec calls (add -b fail, add, rev-parse)");
		assert.deepEqual(calls[1].args, ["worktree", "add", calls[1].args[2], "feature-branch"]);
	});

	it("succeeds (idempotent) even when both attempts fail — returns { ok: true } from dir exists fallback", async () => {
		const pi = createMockPi([
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
			{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
			{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" }, // rev-parse: no remote
		]);
		const { notify } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
	});

	it("returns { ok: false } when both attempts fail and dir does not exist", async () => {
		const pi = createMockPi([
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
			{ code: 1, stdout: "", stderr: "directory not found" }, // test -d fails
		]);		// Both attempts fail AND dir doesn't exist → reconciliation never reached
		const { notify, calls } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("Failed to create worktree"));
			assert.equal(result.source, "worktree");
		}
		// notify.error should be called once
		assert.ok(
			calls.some((c) => c.level === "error"),
			"notify.error should be called on failure",
		);
	});

	it("does not call notify.error when create succeeds", async () => {
		// add succeeds → rev-parse: no remote (128)
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" },
		]);
		const { notify, calls } = createMockNotify();
		const result = await createWorktree(
			pi,
			"/repo",
			"../worktrees",
			"feature-branch",
			"main",
			notify,
		);
		assert.equal(result.ok, true);
		assert.equal(calls.filter((c) => c.level === "error").length, 0);
	});
});

// ─── Tests: installWorktreeDeps() ─────────────────────────────────

describe("installWorktreeDeps()", () => {
	it("copies host dirs then npm ci in worktree — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/main-repo", "/worktree", notify);
		assert.equal(result.ok, true);
		// First call is cp .pi/git (private-pi absent → skipped), second is npm ci
		assert.equal(calls.length, 2);
		assert.equal(calls[0].cmd, "cp");
		assert.ok(calls[0].args.includes("/main-repo/.pi/git"));
		assert.ok(calls[0].args.includes("/worktree/.pi/git"));
		assert.deepEqual(calls[1], {
			cmd: "npm",
			args: ["ci"],
			opts: { cwd: "/worktree", timeout: 120_000 },
		});
	});

	it("copies host-side private-pi clone when present (fail-open when absent)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-copy-"));
		mkdirSync(join(cwd, "private-pi"), { recursive: true });
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await installWorktreeDeps(pi, cwd, "/worktree", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 3);
		assert.equal(calls[0].cmd, "cp");
		assert.ok(calls[0].args.includes(join(cwd, ".pi/git")));
		assert.equal(calls[1].cmd, "cp");
		assert.ok(calls[1].args.includes(join(cwd, "private-pi")));
		assert.ok(calls[1].args.includes("/worktree/private-pi"));
		assert.deepEqual(calls[2], {
			cmd: "npm",
			args: ["ci"],
			opts: { cwd: "/worktree", timeout: 120_000 },
		});
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns { ok: false } on npm ci failure — notify.error called", async () => {
		// cp succeeds, both npm attempts fail
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "network error" },
			{ code: 1, stdout: "", stderr: "still failing" },
		]);
		const { notify, calls } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/main-repo", "/worktree", notify);
		assert.equal(result.ok, false);
		assert.ok(
			calls.some((c) => c.level === "error"),
			"notify.error should be called",
		);
		if (!result.ok) {
			assert.ok(result.error.includes("npm ci failed"));
			assert.equal(result.source, "worktree");
		}
	});

	it("returns { ok: true } on retry success", async () => {
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "network error" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const { notify, calls } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/main-repo", "/worktree", notify);
		assert.equal(result.ok, true);
		// Only retry success — no error notification
		assert.equal(calls.filter((c) => c.level === "error").length, 0);
	});
});

// ─── Tests: deleteBranch() ───────────────────────────────────────

describe("deleteBranch()", () => {
	it("calls git branch -D with correct cwd — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const result = await deleteBranch(pi, "/repo", "feature-branch");
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args, ["branch", "-D", "feature-branch"]);
		assert.deepEqual(calls[0].opts, { cwd: "/repo", timeout: 10000 });
	});

	it("git failure — returns { ok: false, error }", async () => {
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "branch 'missing-branch' not found" }]);
		const result = await deleteBranch(pi, "/repo", "missing-branch");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("not found"), "Error should include git stderr");
			assert.equal(result.source, "worktree");
		}
	});
});

// ─── Tests: cleanupWorktree() ────────────────────────────────────

describe("cleanupWorktree()", () => {
	it("removes worktree and deletes branch — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/worktree"]);
		assert.deepEqual(calls[1].args, ["worktree", "prune"]);
		assert.deepEqual(calls[2].args, ["branch", "-D", "branch"]);
	});

	it("returns { ok: false } on worktree remove failure", async () => {
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "worktree not found" }]);
		const { notify, calls } = createMockNotify();
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.length > 0);
			assert.equal(result.source, "worktree");
		}
		assert.ok(
			calls.some((c) => c.level === "error"),
			"notify.error should be called",
		);
	});

	it("returns { ok: false } when branch delete fails after remove succeeds", async () => {
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "branch not found" },
		]);
		const { notify } = createMockNotify();
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.source, "worktree");
		}
	});

	it("skipBranch=true: executes exactly 2 git commands, no branch -D", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify, true);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 2, "Only 2 git commands with skipBranch=true");
		assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/worktree"]);
		assert.deepEqual(calls[1].args, ["worktree", "prune"]);
		// No third call for branch -D
	});

	it("skipBranch=false (explicit): executes all 3 commands including branch -D", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify, false);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 3, "All 3 git commands with skipBranch=false");
		assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/worktree"]);
		assert.deepEqual(calls[1].args, ["worktree", "prune"]);
		assert.deepEqual(calls[2].args, ["branch", "-D", "branch"]);
	});

	it("skipBranch omitted (default false): executes all 3 commands — backward compat", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		// Same 5-arg call as handler.ts uses — no skipBranch argument
		const result = await cleanupWorktree(pi, "/repo", "/worktree", "branch", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 3, "All 3 git commands when skipBranch omitted");
		assert.deepEqual(calls[2].args, ["branch", "-D", "branch"]);
	});
});

// ─── Tests: reconcileToRemoteBranch() ─────────────────────────────

describe("reconcileToRemoteBranch()", () => {
	it("remote ref exists — fetches and resets worktree, returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		// rev-parse succeeds → fetch succeeds → reset succeeds
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },  // rev-parse
				{ code: 0, stdout: "", stderr: "" },  // fetch
				{ code: 0, stdout: "", stderr: "" },  // reset
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await reconcileToRemoteBranch(pi, "/repo", "/wt", "feature", "origin", notify);
		assert.equal(result.ok, true, "should succeed when remote ref exists");
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "refs/remotes/origin/feature"]);
		assert.deepEqual(calls[1].args, ["fetch", "origin", "feature"]);
		assert.deepEqual(calls[2].args, ["reset", "--hard", "origin/feature"]);
	});

	it("no remote ref — no fetch, no reset, returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		// rev-parse exits 128 (no remote ref)
		const pi = createMockPi(
			[
				{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" },
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await reconcileToRemoteBranch(pi, "/repo", "/wt", "feature", "origin", notify);
		assert.equal(result.ok, true, "should succeed (no-op) when no remote ref");
		assert.equal(calls.length, 1, "only rev-parse call");
	});

	it("fetch fails — returns { ok: false, error }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },  // rev-parse succeeds
				{ code: 1, stdout: "", stderr: "fetch failed: network error" },  // fetch fails
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await reconcileToRemoteBranch(pi, "/repo", "/wt", "feature", "origin", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("fetch failed"), "error should mention fetch failure");
			assert.equal(result.source, "worktree");
		}
		// Should not call notify.error (function returns error, caller decides fatality)
		assert.equal(notifyCalls.length, 0, "reconcileToRemoteBranch should not call notify itself");
	});

	it("fetch succeeds but reset fails — returns { ok: false }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },  // rev-parse succeeds
				{ code: 0, stdout: "", stderr: "" },  // fetch succeeds
				{ code: 1, stdout: "", stderr: "reset failed: dirty index" },  // reset fails
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await reconcileToRemoteBranch(pi, "/repo", "/wt", "feature", "origin", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("reset failed"), "error should mention reset failure");
			assert.equal(result.source, "worktree");
		}
	});

	it("calls notify.info on successful reconciliation", async () => {
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },  // rev-parse
			{ code: 0, stdout: "", stderr: "" },  // fetch
			{ code: 0, stdout: "", stderr: "" },  // reset
		]);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await reconcileToRemoteBranch(pi, "/repo", "/wt", "feature", "origin", notify);
		assert.equal(result.ok, true);
		// notify.info should be called with reconciliation message
		const reconcileInfo = notifyCalls.find((c) => c.msg.includes("Reconciled worktree to remote"));
		assert.ok(reconcileInfo, "notify.info should be called on successful reconciliation");
	});

	it("first run (no remote) — createWorktree exec call count unchanged from expected", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },  // worktree add -b succeeds
				{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" },  // rev-parse: no remote
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "feature", "main", notify);
		assert.equal(result.ok, true);
		// Only 2 calls: worktree add + rev-parse (no fetch/reset since no remote)
		assert.equal(calls.length, 2, "should have 2 exec calls on first run (add + no-op rev-parse)");
	});
});
