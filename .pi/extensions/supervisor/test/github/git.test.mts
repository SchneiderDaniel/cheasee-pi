// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T>.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitChanges, pushBranch, commitAndPush } from "../../github/git.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(results: Array<{ code: number; stdout: string; stderr: string }>): {
	pi: ExtensionAPI;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	let idx = 0;
	const pi = {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
	return { pi, calls };
}

function createMockNotify(): { notify: NotifyFn; calls: Array<{ level: string; msg: string }> } {
	const calls: Array<{ level: string; msg: string }> = [];
	const notify: NotifyFn = {
		info: (msg: string) => calls.push({ level: "info", msg }),
		error: (msg: string) => calls.push({ level: "error", msg }),
	};
	return { notify, calls };
}

// ─── Tests: commitChanges() ───────────────────────────────────────

describe("commitChanges()", () => {
	it("calls git commit with correct args", async () => {
		const { pi, calls } = createMockPi([{ code: 0, stdout: "committed", stderr: "" }]);
		await commitChanges(pi, "/tmp/worktree", "feat(#123): add feature");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["commit", "-m", "feat(#123): add feature"]);
		assert.equal(calls[0].opts.cwd, "/tmp/worktree");
	});

	it("throws on git commit failure (unchanged)", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "nothing to commit" }]);
		await assert.rejects(() => commitChanges(pi, "/tmp/worktree", "msg"), /git commit failed/);
	});
});

// ─── Tests: pushBranch() ──────────────────────────────────────────

describe("pushBranch() — Result<T>", () => {
	it("calls git push with correct args — returns { ok: true }", async () => {
		const { pi, calls } = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		const { notify } = createMockNotify();
		const result = await pushBranch(pi, "/tmp/worktree", "origin", "feature-branch", notify);
		assert.equal(result.ok, true);
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["push", "origin", "feature-branch"]);
	});

	it("returns { ok: false } on git push failure — no throw", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "rejected" }]);
		const { notify, calls } = createMockNotify();
		const result = await pushBranch(pi, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git push failed"));
			assert.equal(result.source, "git");
		}
		assert.ok(
			calls.some((c) => c.level === "error"),
			"notify.error should be called",
		);
	});

	it("non-fast-forward retry with --force succeeds — returns { ok: true }", async () => {
		const { pi, calls } = createMockPi([
			{ code: 1, stdout: "", stderr: "non-fast-forward" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const { notify } = createMockNotify();
		const result = await pushBranch(pi, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1].args, ["push", "--force", "origin", "feature"]);
	});

	it("non-fast-forward retry with --force also fails — returns { ok: false }", async () => {
		const { pi, calls } = createMockPi([
			{ code: 1, stdout: "", stderr: "non-fast-forward" },
			{ code: 1, stdout: "", stderr: "force push rejected" },
		]);
		const { notify } = createMockNotify();
		const result = await pushBranch(pi, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git push --force failed"));
		}
	});
});

// ─── Tests: commitAndPush() ───────────────────────────────────────

describe("commitAndPush() — Result<T>", () => {
	it("stages all changes, commits, then pushes — returns { ok: true, value: true }", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 0, stdout: "committed", stderr: "" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(
			pi,
			"/tmp/worktree",
			"origin",
			"feature",
			"feat(#123): msg",
			notify,
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
		assert.equal(calls.length, 4);
		assert.deepEqual(calls[0].args, ["add", "-A"]);
		assert.deepEqual(calls[1].args, ["diff", "--cached", "--quiet"]);
		assert.deepEqual(calls[2].args, ["commit", "-m", "feat(#123): msg"]);
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("resolves successfully when git commit returns 'nothing to commit' — calls pushBranch", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // push succeeds
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
		assert.equal(calls.length, 4);
		assert.equal(calls[3].cmd, "git");
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("does not throw when nothing to commit and push succeeds — returns { ok: true }", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
	});

	it("returns { ok: false } when git add fails", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "fatal error" }]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git add failed"));
		}
	});

	it("returns { ok: false } when git commit fails with real error (not 'nothing to commit')", async () => {
		const { pi } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "fatal: bad config" }, // git commit
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git commit failed"));
		}
	});

	it("calls pushBranch even when nothing to commit (no short-circuit)", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 4, "should call push even when nothing to commit");
		assert.equal(calls[3].cmd, "git");
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("returns { ok: false } when push fails (after add+commit succeed)", async () => {
		const { pi } = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 0, stdout: "", stderr: "" }, // git commit
			{ code: 1, stdout: "", stderr: "push failed: network error" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(
				result.error.includes("git push failed"),
				`error should mention push: ${result.error}`,
			);
		}
	});
});
