// ─── Tests: pipeline/worktree.ts — worktree lifecycle ───────────
// Tests with mock pi.exec. No git operations.
// All functions return Result<T> — tests assert .ok shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createWorktree,
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
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
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
	});

	it("falls back to add without -b when first attempt fails — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "already exists" },
				{ code: 0, stdout: "", stderr: "" },
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
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1].args, ["worktree", "add", calls[1].args[2], "feature-branch"]);
	});

	it("succeeds (idempotent) even when both attempts fail — returns { ok: true } from dir exists fallback", async () => {
		const pi = createMockPi([
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
			{ code: 0, stdout: "", stderr: "" }, // test -d succeeds
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
		]);
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
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
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
	it("runs npm ci in worktree path — returns { ok: true }", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const { notify } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/worktree", notify);
		assert.equal(result.ok, true);
		assert.deepEqual(calls[0], {
			cmd: "npm",
			args: ["ci"],
			opts: { cwd: "/worktree", timeout: 120_000 },
		});
	});

	it("returns { ok: false } on npm ci failure — notify.error called", async () => {
		// Both attempts must fail — provide 2 failing results
		const pi = createMockPi([
			{ code: 1, stdout: "", stderr: "network error" },
			{ code: 1, stdout: "", stderr: "still failing" },
		]);
		const { notify, calls } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/worktree", notify);
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
			{ code: 1, stdout: "", stderr: "network error" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const { notify, calls } = createMockNotify();
		const result = await installWorktreeDeps(pi, "/worktree", notify);
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
