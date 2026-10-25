// ─── Tests: pipeline/worktree.ts — worktree lifecycle ───────────
// Tests with mock pi.exec. No git operations.
// All functions return Result<T> — tests assert .ok shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorktree, recoverStaleWorktreeRegistration } from "../../pipeline/worktree.ts";
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
			// Real pi.exec never rejects on non-zero exit — it resolves {code}.
			// Return as-is; callers must check result.code.
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

/**
 * Create a mock pi.exec that records calls but doesn't execute results in order.
 * Unlike createMockPi, this uses a map of command patterns to results for when
 * you need different responses for different commands (e.g., rev-parse=0 vs fetch=0).
 */
function createMockPiWithDefaults(defaultResult: {
	code: number;
	stdout: string;
	stderr: string;
}): ExtensionAPI {
	const callLog: ExecCall[] = [];
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = { ...defaultResult };
			// Real pi.exec never rejects on non-zero exit — it resolves {code}.
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

// ─── Tests: recoverStaleWorktreeRegistration() ────────────────────

describe("recoverStaleWorktreeRegistration()", () => {
	it("unlocks + prunes a stale registration when worktree dir is missing", async () => {
		// Real fs fixture: bare admin dir with a stale (locked) registration.
		// worktreeBase "../worktrees" resolves to cwd's parent — the worktree
		// dir there does NOT exist, so recovery must trigger.
		const cwd = mkdtempSync(join(tmpdir(), "wt-recover-"));
		const bareWorktrees = join(cwd, ".bare", "worktrees");
		const regDir = join(bareWorktrees, "stale-branch");
		mkdirSync(regDir, { recursive: true });
		writeFileSync(join(regDir, "locked"), "Locked by entrypoint.sh");
		writeFileSync(join(regDir, "gitdir"), "../../../stale-branch/.git");

		const calls: ExecCall[] = [];
		// rev-parse --git-common-dir → bare dir; rm lock ok; prune ok
		const pi = createMockPi(
			[
				{ code: 0, stdout: join(cwd, ".bare"), stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		await recoverStaleWorktreeRegistration(pi, cwd, "../worktrees", "stale-branch");
		// exec sequence: probe → rm lock → prune
		assert.deepEqual(calls[0].args, ["rev-parse", "--git-common-dir"]);
		assert.equal(calls[1].cmd, "rm");
		assert.deepEqual(calls[1].args, ["-f", join(regDir, "locked")]);
		assert.deepEqual(calls[2].args, ["worktree", "prune"]);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("no-ops when the worktree dir still exists (live worktree — never pruned)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-recover-live-"));
		// Live worktree dir exists at the resolved location (cwd's parent
		// + worktreeBase + branch) → recovery must not run any exec.
		const liveDir = join(dirname(cwd), "worktrees", "live-branch");
		mkdirSync(liveDir, { recursive: true });
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		await recoverStaleWorktreeRegistration(pi, cwd, "../worktrees", "live-branch");
		assert.equal(calls.length, 0, "live worktree must not trigger any exec");
		rmSync(cwd, { recursive: true, force: true });
	});

	it("no-ops when no stale registration exists", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-recover-none-"));
		const calls: ExecCall[] = [];
		// rev-parse returns a bare dir with no worktrees/ghost-branch registration
		const pi = createMockPi([{ code: 0, stdout: join(cwd, ".bare"), stderr: "" }], calls);
		await recoverStaleWorktreeRegistration(pi, cwd, "../worktrees", "ghost-branch");
		assert.equal(calls.length, 1, "only the probe rev-parse, no unlock/prune");
		rmSync(cwd, { recursive: true, force: true });
	});
});

// ─── Tests: createWorktree() ─────────────────────────────────────

describe("createWorktree()", () => {
	it("creates worktree with -b flag on first attempt — returns { ok: true, value }", async () => {
		const calls: ExecCall[] = [];
		// rev-parse common dir (recovery probe, no stale reg) → add succeeds →
		// reconciliation: rev-parse exits 128 (no remote ref)
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" },
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
		assert.deepEqual(calls[1].args, [
			"worktree",
			"add",
			"-b",
			"feature-branch",
			result.ok ? result.value : "",
			"main",
		]);
		// recovery probe (rev-parse common dir) + add + reconciliation ls-remote
		assert.equal(calls.length, 3, "should have 3 exec calls (rev-parse, add, ls-remote)");
		assert.deepEqual(calls[2].args, [
			"ls-remote",
			"--heads",
			"origin",
			"refs/heads/feature-branch",
		]);
	});

	it("falls back to add without -b when first attempt fails — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" },
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
		assert.equal(
			calls.length,
			4,
			"should have 4 exec calls (rev-parse, add -b fail, add, ls-remote)",
		);
		assert.deepEqual(calls[2].args, ["worktree", "add", calls[2].args[2], "feature-branch"]);
	});

	it("succeeds (idempotent) even when both attempts fail — returns { ok: true } from dir exists fallback", async () => {
		const pi = createMockPi([
			{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe: no stale reg
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
			{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
			{ code: 128, stdout: "", stderr: "fatal: Needed a single revision" }, // ls-remote: unreachable → skip
		]);
		const { notify } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
	});

	it("returns { ok: false } when both attempts fail and dir does not exist", async () => {
		const pi = createMockPi([
			{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe: no stale reg
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
			{ code: 1, stdout: "", stderr: "directory not found" }, // test -d fails
		]); // Both attempts fail AND dir doesn't exist → reconciliation never reached
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
		// recovery probe (no stale reg) → add succeeds → ls-remote: no remote (128)
		const pi = createMockPi([
			{ code: 0, stdout: "/repo/.bare", stderr: "" },
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

	it("attempt 1 add succeeds + remote exists — reconciles in place, 5 calls in order", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe
				{ code: 0, stdout: "", stderr: "" }, // add -b succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 0, stdout: "", stderr: "" }, // fetch succeeds
				{ code: 0, stdout: "", stderr: "" }, // reset succeeds
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
		if (result.ok) assert.ok(result.value.endsWith("branch"));
		assert.equal(calls.length, 5);
		assert.deepEqual(calls[0].args, ["rev-parse", "--git-common-dir"]);
		assert.deepEqual(calls[1].args.slice(0, 3), ["worktree", "add", "-b"]);
		assert.deepEqual(calls[2].args, ["ls-remote", "--heads", "origin", "refs/heads/branch"]);
		assert.deepEqual(calls[3].args, ["fetch", "origin", "branch"]);
		assert.deepEqual(calls[4].args, ["reset", "--hard", "origin/branch"]);
		assert.ok(
			notifyCalls.some(
				(c) => c.level === "info" && c.msg.includes("Reconciled worktree to remote"),
			),
		);
	});

	it("attempt 2 add succeeds + remote exists — reconciles in place, 6 calls", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe
				{ code: 1, stdout: "", stderr: "already exists" }, // add -b fails
				{ code: 0, stdout: "", stderr: "" }, // add succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 0, stdout: "", stderr: "" }, // fetch succeeds
				{ code: 0, stdout: "", stderr: "" }, // reset succeeds
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 6);
		assert.deepEqual(calls[2].args, ["worktree", "add", calls[2].args[2], "branch"]);
	});

	it("dir-exists fallback + remote exists — reconciles in place, 7 calls", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe
				{ code: 1, stdout: "", stderr: "error" }, // add -b fails
				{ code: 1, stdout: "", stderr: "already exists" }, // add fails
				{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 0, stdout: "", stderr: "" }, // fetch succeeds
				{ code: 0, stdout: "", stderr: "" }, // reset succeeds
			],
			calls,
		);
		const { notify } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 7);
		assert.equal(calls[3].cmd, "test");
	});

	it("fatal reconcile on dir-exists fallback — returns { ok: false, Reconciliation failed }, notify.error once, no reset", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe: no stale reg
				{ code: 1, stdout: "", stderr: "error" }, // add -b fails
				{ code: 1, stdout: "", stderr: "already exists" }, // add fails
				{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 1, stdout: "", stderr: "network error" }, // fetch fails → fatal
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("Reconciliation failed"));
			assert.equal(result.source, "worktree");
		}
		assert.equal(notifyCalls.filter((c) => c.level === "error").length, 1, "notify.error once");
		assert.equal(calls.length, 6, "no reset attempted after fatal fetch");
		assert.equal(calls[4].cmd, "git");
		assert.deepEqual(calls[4].args, ["ls-remote", "--heads", "origin", "refs/heads/branch"]);
	});

	it("attempt 1 reconcile fatal cascades to attempt 2 — { ok: true }, no notify.error", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe
				{ code: 0, stdout: "", stderr: "" }, // add -b succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 1, stdout: "", stderr: "network error" }, // fetch fails → fatal (caught)
				{ code: 0, stdout: "", stderr: "" }, // attempt 2: add succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote
				{ code: 0, stdout: "", stderr: "" }, // fetch succeeds
				{ code: 0, stdout: "", stderr: "" }, // reset succeeds
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 8);
		assert.equal(
			notifyCalls.filter((c) => c.level === "error").length,
			0,
			"attempt-1 fatal must be swallowed",
		);
	});

	it("attempt 2 reconcile fatal cascades to dir-exists fallback — { ok: true }, no notify.error", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "/repo/.bare", stderr: "" }, // recovery probe
				{ code: 1, stdout: "", stderr: "error" }, // add -b fails
				{ code: 0, stdout: "", stderr: "" }, // attempt 2: add succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote: remote exists
				{ code: 1, stdout: "", stderr: "network error" }, // fetch fails → fatal (caught)
				{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
				{ code: 0, stdout: "abc123\trefs/heads/branch\n", stderr: "" }, // ls-remote
				{ code: 0, stdout: "", stderr: "" }, // fetch succeeds
				{ code: 0, stdout: "", stderr: "" }, // reset succeeds
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();
		const result = await createWorktree(pi, "/repo", "../worktrees", "branch", "main", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 9);
		assert.equal(
			notifyCalls.filter((c) => c.level === "error").length,
			0,
			"attempt-2 fatal must be swallowed",
		);
	});
});

// ─── Tests: installWorktreeDeps() ─────────────────────────────────
