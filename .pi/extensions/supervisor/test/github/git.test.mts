// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T>.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "../../../lib/port-types.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { commitChanges, pushBranch, workflowScopeHint } from "../../github/git.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

const execFileP = promisify(execFile);

// ─── Real-git harness (regression: workflow-scope identical-file exemption) ──

/** ExecFn that shells out to real git (mirrors pipeline-worktree-integration). */
function realGitExec(cwd: string): ExecFn {
	return async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
		try {
			const { stdout, stderr } = await execFileP(cmd, args, {
				cwd: opts?.cwd ?? cwd,
				encoding: "utf-8",
			});
			return { code: 0, stdout, stderr, killed: false };
		} catch (err: unknown) {
			const e = err as { code?: number; stdout?: string; stderr?: string };
			return {
				code: typeof e.code === "number" ? e.code : 1,
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? String(err),
				killed: false,
			};
		}
	};
}

async function realGit(dir: string, args: string[]): Promise<void> {
	const result = await realGitExec(dir)("git", args, { cwd: dir });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
}

/**
 * Repo fixture: local clone `work` with a bare `origin` remote. main has no
 * workflow file; branch `other` holds `.github/workflows/ci.yml` (pushed to
 * origin); branch `feature` (checked out) is at the main baseline so the
 * workflow file can be staged fresh onto it. Server branch coverage is
 * authoritative: origin/heads == refs/remotes/origin (both branches pushed).
 */
async function initWorkflowFixture(): Promise<{ dir: string; cleanup: () => void }> {
	const root = mkdtempSync(join(tmpdir(), "wf-exempt-"));
	const origin = join(root, "origin.git");
	const dir = join(root, "work");
	await realGit(root, ["init", "--bare", "-b", "main", "origin.git"]);
	mkdirSync(dir);
	writeFileSync(join(dir, "README.md"), "base\n");
	await realGit(dir, ["init", "-b", "main"]);
	await realGit(dir, ["config", "user.email", "test@example.com"]);
	await realGit(dir, ["config", "user.name", "Test"]);
	await realGit(dir, ["add", "."]);
	await realGit(dir, ["commit", "-m", "base"]);
	await realGit(dir, ["remote", "add", "origin", origin]);
	await realGit(dir, ["push", "-u", "origin", "main"]);
	await realGit(dir, ["checkout", "-b", "other"]);
	mkdirSync(join(dir, ".github/workflows"), { recursive: true });
	writeFileSync(join(dir, ".github/workflows/ci.yml"), "v1\n");
	await realGit(dir, ["add", "."]);
	await realGit(dir, ["commit", "-m", "workflow on other"]);
	await realGit(dir, ["push", "-u", "origin", "other"]);
	await realGit(dir, ["checkout", "main"]);
	await realGit(dir, ["checkout", "-b", "feature"]);
	return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockExec(results: Array<{ code: number; stdout: string; stderr: string }>): {
	exec: ExecFn;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	let idx = 0;
	const exec: ExecFn = async (
		cmd: string,
		args: string[],
		opts?: ExecOptions,
	): Promise<ExecResult> => {
		calls.push({ cmd, args: args || [], opts: (opts || {}) as Record<string, unknown> });
		const r = results[idx++] || { code: 0, stdout: "", stderr: "" };
		return { ...r, killed: false };
	};
	return { exec, calls };
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
		const { exec, calls } = createMockExec([{ code: 0, stdout: "committed", stderr: "" }]);
		await commitChanges(exec, "/tmp/worktree", "feat(#123): add feature");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["commit", "-m", "feat(#123): add feature"]);
		assert.equal(calls[0].opts.cwd, "/tmp/worktree");
	});

	it("throws on git commit failure (unchanged)", async () => {
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr: "nothing to commit" }]);
		await assert.rejects(() => commitChanges(exec, "/tmp/worktree", "msg"), /git commit failed/);
	});
});

// ─── Tests: pushBranch() ──────────────────────────────────────────

describe("pushBranch() — Result<T>", () => {
	it("calls git push with correct args — returns { ok: true }", async () => {
		const { exec, calls } = createMockExec([{ code: 0, stdout: "", stderr: "" }]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature-branch", notify);
		assert.equal(result.ok, true);
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["push", "origin", "feature-branch"]);
	});

	it("returns { ok: false } on git push failure — no throw", async () => {
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr: "rejected" }]);
		const { notify, calls } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
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

	it("non-fast-forward retry with --force-with-lease succeeds — returns { ok: true }", async () => {
		const { exec, calls } = createMockExec([
			{ code: 1, stdout: "", stderr: "non-fast-forward" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1].args, ["push", "--force-with-lease", "origin", "feature"]);
	});

	it("non-fast-forward retry with --force-with-lease also fails — returns { ok: false }, error mentions force-with-lease", async () => {
		const { exec, calls } = createMockExec([
			{ code: 1, stdout: "", stderr: "non-fast-forward" },
			{ code: 1, stdout: "", stderr: "force push rejected" },
		]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git push --force-with-lease failed"));
		}
		assert.equal(
			calls.filter((c) => c.args[0] === "push" && c.args[1] === "--force").length,
			0,
			"plain --force must never be invoked",
		);
	});

	it("workflow-scope rejection — error carries the GitHub clause and a remediation hint", async () => {
		const stderr = [
			"To https://github.com/SchneiderDaniel/cheasee-pi.git",
			" ! [remote rejected] abc123 -> worktree-git-issue-1519-feature-ci (refusing to allow an OAuth App to create or update workflow `.github/workflows/tests.yml` without `workflow` scope)",
			"error: failed to push some refs",
		].join("\n");
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr }]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("(refusing to allow an OAuth App"), result.error);
			assert.ok(result.error.includes("workflow` scope)"), result.error);
			assert.ok(result.error.includes("— remediation:"), result.error);
		}
	});

	it("PAT variant of the workflow-scope rejection also gets the remediation hint", async () => {
		const stderr =
			"! [remote rejected] abc123 -> br (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/a.yml` without `workflow` scope)";
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr }]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("remediation:"), result.error);
			assert.ok(result.error.includes("without `workflow` scope"), result.error);
		}
	});

	it("non-workflow push failures stay byte-identical (no remediation suffix)", async () => {
		const stderr = "! [remote rejected] abc123 -> br (protected branch hook declined)";
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr }]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes(stderr), result.error);
			assert.ok(!result.error.includes("remediation:"), result.error);
		}
	});

	it("workflowScopeHint selects the remediation by token class", () => {
		assert.ok(workflowScopeHint("cheasee-pi").includes("cheasee-pi init --reauth"));
		assert.ok(workflowScopeHint("gh").includes("gh auth refresh -h github.com -s workflow"));
		assert.ok(!workflowScopeHint("cheasee-pi").includes("gh auth refresh"));
		assert.ok(!workflowScopeHint("gh").includes("cheasee-pi init"));
	});

	it("lease rejection (remote advanced since fetch) — fails closed { ok: false }, no clobber path", async () => {
		// --force-with-lease refuses when the remote ref moved since our last
		// fetch; the push must fail closed instead of overwriting the unseen change.
		const { exec, calls } = createMockExec([
			{ code: 1, stdout: "", stderr: "non-fast-forward" },
			{
				code: 1,
				stdout: "",
				stderr:
					"[rejected] (stale info) — remote refs/heads/feature has moved since the last fetch",
			},
		]);
		const { notify } = createMockNotify();
		const result = await pushBranch(exec, "/tmp/worktree", "origin", "feature", notify);
		assert.equal(result.ok, false, "lease rejection must fail closed");
		assert.equal(calls.length, 2, "exactly one retry attempt");
		assert.deepEqual(calls[1].args, ["push", "--force-with-lease", "origin", "feature"]);
	});
});

// ─── Tests: commitAndPush() ───────────────────────────────────────
