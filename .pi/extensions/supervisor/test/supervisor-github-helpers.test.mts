/**
 * Tests for git/GitHub deterministic helpers (Phase 1).
 *
 * Phase 1: pushBranch, commitChanges, commitAndPush
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-github-helpers.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { pushBranch, commitChanges, commitAndPush } from "../github/git.ts";
import type { ExecFn, NotifyFn } from "../pipeline/helpers.ts";
import type { ExecOptions } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
	cmd: string;
	args: string[];
	opts?: Record<string, unknown>;
}

const noopNotify: NotifyFn = {
	info: () => {},
	error: () => {},
};

function makeMockExec(results: Array<{ code: number; stdout?: string; stderr?: string }> = []) {
	let callIndex = 0;
	const calls: ExecCall[] = [];
	const exec: ExecFn = async (_cmd: string, _args: string[], _opts?: ExecOptions) => {
		const idx = callIndex++;
		calls.push({ cmd: _cmd, args: _args, opts: (_opts || {}) as Record<string, unknown> });
		const result = idx < results.length ? results[idx] : { code: 0, stdout: "", stderr: "" };
		return {
			code: result.code ?? 0,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			killed: false,
		};
	};
	return { exec, calls };
}

// ---------------------------------------------------------------------------
// Tests — commitChanges
// ---------------------------------------------------------------------------

describe("commitChanges", () => {
	it("calls pi.exec(git, [commit, -m, msg], {cwd}) and returns on code 0", async () => {
		const { exec, calls } = makeMockExec([{ code: 0, stdout: "1 file changed" }]);
		await commitChanges(exec, "/some/cwd", "feat(#42): add feature");
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["commit", "-m", "feat(#42): add feature"]);
		assert.deepStrictEqual(calls[0].opts, { cwd: "/some/cwd" });
	});

	it("throws error when pi.exec returns non-zero", async () => {
		const { exec } = makeMockExec([{ code: 1, stderr: "nothing to commit" }]);
		await assert.rejects(() => commitChanges(exec, "/cwd", "msg"), /git commit failed/i);
	});

	it("throws error when pi.exec throws", async () => {
		const exec: ExecFn = async () => {
			throw new Error("git not found");
		};
		await assert.rejects(() => commitChanges(exec, "/cwd", "msg"), /git not found/i);
	});
});

// ---------------------------------------------------------------------------
// Tests — pushBranch
// ---------------------------------------------------------------------------

describe("pushBranch", () => {
	it("calls pi.exec(git, [push, remote, branch], {cwd})", async () => {
		const { exec, calls } = makeMockExec([{ code: 0, stdout: "Everything up-to-date" }]);
		const result = await pushBranch(exec, "/cwd", "origin", "my-branch", noopNotify);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["push", "origin", "my-branch"]);
		assert.deepStrictEqual(calls[0].opts, { cwd: "/cwd" });
	});

	it("returns { ok: false } on push failure (auth fail, rejected, no remote)", async () => {
		const { exec } = makeMockExec([{ code: 128, stderr: "fatal: Authentication failed" }]);
		const result = await pushBranch(exec, "/cwd", "origin", "branch", noopNotify);
		assert.strictEqual(result.ok, false);
	});
});

// ---------------------------------------------------------------------------
// Tests — commitAndPush
// ---------------------------------------------------------------------------

describe("commitAndPush", () => {
	it("calls git add, diff, commit, then push in sequence", async () => {
		const { exec, calls } = makeMockExec([
			{ code: 0, stdout: "" }, // add -A
			{ code: 1, stdout: "" }, // diff --cached --quiet (has staged changes)
			{ code: 0, stdout: "1 file changed" }, // commit
			{ code: 0, stdout: "Everything up-to-date" }, // push
		]);
		const result = await commitAndPush(
			exec,
			"/cwd",
			"origin",
			"branch",
			"feat(#42): msg",
			noopNotify,
		);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(calls.length, 4);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["add", "-A"]);
		assert.strictEqual(calls[1].cmd, "git");
		assert.deepStrictEqual(calls[1].args, ["diff", "--cached", "--quiet"]);
		assert.strictEqual(calls[2].cmd, "git");
		assert.deepStrictEqual(calls[2].args, ["commit", "-m", "feat(#42): msg"]);
		assert.strictEqual(calls[3].cmd, "git");
		assert.deepStrictEqual(calls[3].args, ["push", "origin", "branch"]);
	});

	it("returns { ok: false } if add fails (short-circuit)", async () => {
		const { exec, calls } = makeMockExec([{ code: 1, stderr: "permission denied" }]);
		const result = await commitAndPush(exec, "/cwd", "origin", "branch", "msg", noopNotify);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(calls.length, 1); // only add, not commit/push
	});

	it("handles 'nothing to commit' gracefully — calls pushBranch anyway", async () => {
		const { exec, calls } = makeMockExec([
			{ code: 0, stdout: "" }, // add -A
			{ code: 1, stdout: "" }, // diff --cached --quiet (has staged changes)
			{ code: 1, stderr: "nothing to commit" }, // commit fails
			{ code: 0, stdout: "Everything up-to-date" }, // push
		]);
		// Should NOT throw — pipeline continues gracefully
		const result = await commitAndPush(exec, "/cwd", "origin", "branch", "msg", noopNotify);
		assert.strictEqual(result.ok, true);
		// pushBranch is called even when nothing to commit (branch may not exist on remote)
		assert.strictEqual(calls.length, 4); // add + diff + commit + push
		assert.strictEqual(calls[3].cmd, "git");
		assert.deepStrictEqual(calls[3].args, ["push", "origin", "branch"]);
	});
});

// ---------------------------------------------------------------------------
