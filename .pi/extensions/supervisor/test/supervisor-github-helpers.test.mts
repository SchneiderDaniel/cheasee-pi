/**
 * Tests for git/GitHub deterministic helpers (Phase 1).
 *
 * Phase 1: pushBranch, commitChanges, commitAndPush, createPullRequest
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-github-helpers.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { pushBranch, commitChanges, commitAndPush } from "../github/git.ts";
import { createPullRequest } from "../github/pr.ts";
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
// Tests — createPullRequest
// ---------------------------------------------------------------------------

describe("createPullRequest", () => {
	it("calls gh pr create with correct args without --json flag", async () => {
		const { exec, calls } = makeMockExec([
			{ code: 0, stdout: "https://github.com/owner/repo/pull/123" },
		]);
		const result = await createPullRequest(
			exec,
			"owner/repo",
			"main",
			"branch",
			"feat(#42): title",
		);
		assert.strictEqual(calls.length, 1);
		// gh() wrapper may call bash with GH_TOKEN injection or gh directly
		const cmd = calls[0].cmd;
		const args = calls[0].args;
		assert.ok(cmd === "gh" || cmd === "bash", "cmd should be gh or bash wrapper");
		// Extract gh subcommand args: if bash wrapper, they start at index 3 (after -c, shellCmd, _)
		const ghArgs = cmd === "bash" ? args.slice(3) : args;
		assert.deepStrictEqual(ghArgs, [
			"pr",
			"create",
			"--repo",
			"owner/repo",
			"--base",
			"main",
			"--head",
			"branch",
			"--title",
			"feat(#42): title",
		]);
		assert.equal(args.includes("--json"), false, "should NOT include --json flag");
		assert.deepStrictEqual(result, { number: 123 });
	});

	it("includes --body-file flag when bodyFile provided", async () => {
		const { exec, calls } = makeMockExec([
			{ code: 0, stdout: "https://github.com/owner/repo/pull/456" },
		]);
		await createPullRequest(exec, "owner/repo", "main", "branch", "title", "/tmp/body.md");
		assert.strictEqual(calls.length, 1);
		const cmd = calls[0].cmd;
		const args = calls[0].args;
		// Extract gh subcommand args: if bash wrapper, they start at index 3
		const ghArgs = cmd === "bash" ? args.slice(3) : args;
		assert.ok(ghArgs.includes("--body-file"), "Expected --body-file in args");
		assert.equal(ghArgs.includes("--json"), false, "should NOT include --json flag");
		const bfIdx = ghArgs.indexOf("--body-file");
		assert.strictEqual(ghArgs[bfIdx + 1], "/tmp/body.md");
	});

	it("throws on text-with-number like 'PR #42' (tightened regex guard)", async () => {
		const { exec } = makeMockExec([{ code: 0, stdout: "PR #42" }]);
		await assert.rejects(
			() => createPullRequest(exec, "owner/repo", "main", "branch", "title"),
			/failed to parse PR number/i,
		);
	});

	it("parses PR number when gh outputs plain URL (backward compat)", async () => {
		const { exec } = makeMockExec([{ code: 0, stdout: "https://github.com/owner/repo/pull/321" }]);
		const result = await createPullRequest(exec, "owner/repo", "main", "branch", "title");
		assert.deepStrictEqual(result, { number: 321 });
	});

	it("parses PR number when gh outputs plain number (backward compat)", async () => {
		const { exec } = makeMockExec([{ code: 0, stdout: "555" }]);
		const result = await createPullRequest(exec, "owner/repo", "main", "branch", "title");
		assert.deepStrictEqual(result, { number: 555 });
	});

	it("throws when gh returns non-zero", async () => {
		const { exec } = makeMockExec([{ code: 1, stderr: "gh: Not authenticated" }]);
		await assert.rejects(
			() => createPullRequest(exec, "owner/repo", "main", "branch", "title"),
			/gh pr failed/i,
		);
	});

	it("throws when gh output does not contain a number", async () => {
		const { exec } = makeMockExec([{ code: 0, stdout: "" }]);
		await assert.rejects(
			() => createPullRequest(exec, "owner/repo", "main", "branch", "title"),
			/failed to parse PR number/i,
		);
	});
});
