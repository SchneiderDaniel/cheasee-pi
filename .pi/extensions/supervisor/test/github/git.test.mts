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
import type { ExecFn } from "../../pipeline/helpers.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
	commitChanges,
	pushBranch,
	commitAndPush,
	workflowScopeHint,
	workflowChangesExempt,
} from "../../github/git.ts";
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
 * Repo fixture: main has no workflow file; branch `other` holds
 * `.github/workflows/ci.yml`; branch `feature` (checked out) is at the main
 * baseline so the workflow file can be staged fresh onto it.
 */
async function initWorkflowFixture(): Promise<{ dir: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "wf-exempt-"));
	writeFileSync(join(dir, "README.md"), "base\n");
	await realGit(dir, ["init", "-b", "main"]);
	await realGit(dir, ["config", "user.email", "test@example.com"]);
	await realGit(dir, ["config", "user.name", "Test"]);
	await realGit(dir, ["add", "."]);
	await realGit(dir, ["commit", "-m", "base"]);
	await realGit(dir, ["checkout", "-b", "other"]);
	mkdirSync(join(dir, ".github/workflows"), { recursive: true });
	writeFileSync(join(dir, ".github/workflows/ci.yml"), "v1\n");
	await realGit(dir, ["add", "."]);
	await realGit(dir, ["commit", "-m", "workflow on other"]);
	await realGit(dir, ["checkout", "main"]);
	await realGit(dir, ["checkout", "-b", "feature"]);
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

describe("commitAndPush() — Result<T>", () => {
	it("stages all changes, commits, then pushes — returns { ok: true, value: true }", async () => {
		const { exec, calls } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 0, stdout: "committed", stderr: "" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(
			exec,
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
		assert.deepEqual(calls[1].args, ["diff", "--cached", "--name-only", "--exit-code"]);
		assert.deepEqual(calls[2].args, ["commit", "-m", "feat(#123): msg"]);
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("pre-push gate: staged workflow file + token lacking workflow scope — aborts before commit/push with remediation hint", async () => {
		const { exec, calls } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{
				code: 1,
				stdout: ".github/workflows/ci.yml\n",
				stderr: "",
			}, // git diff --cached --name-only (differences staged)
			{
				code: 0,
				stdout: "HTTP/2.0 200 OK\nx-oauth-scopes: repo, read:org, project\n\n{}",
				stderr: "",
			}, // gh api -i /user — scope header lacks workflow
			{
				code: 0,
				stdout: "refs/heads/main\nrefs/remotes/origin/main\n",
				stderr: "",
			}, // for-each-ref — head + remote-tracking refs
			{ code: 0, stdout: "sha-new\n", stderr: "" }, // rev-parse :ci.yml (staged blob)
			{ code: 1, stdout: "", stderr: "" }, // rev-parse refs/heads/main:ci.yml — missing
			{ code: 1, stdout: "", stderr: "" }, // rev-parse refs/remotes/origin/main:ci.yml — missing
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("workflow scope"), result.error);
			assert.ok(result.error.includes("remediation:"), result.error);
		}
		const commitPushCalls = calls.filter((c) => c.args[0] === "commit" || c.args[0] === "push");
		assert.equal(commitPushCalls.length, 0, "must abort before commit and push round-trip");
	});

	it("pre-push gate: identical workflow file already on another branch — exemption lets the push proceed", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{
				code: 1,
				stdout: ".github/workflows/ci.yml\n",
				stderr: "",
			}, // git diff --cached --name-only
			{
				code: 0,
				stdout: "HTTP/2.0 200 OK\nx-oauth-scopes: repo, read:org, project\n\n{}",
				stderr: "",
			}, // gh api -i /user — token lacks workflow
			{
				code: 0,
				stdout: "refs/heads/main\nrefs/remotes/origin/main\n",
				stderr: "",
			}, // for-each-ref
			{ code: 0, stdout: "sha-same\n", stderr: "" }, // rev-parse :ci.yml (staged blob)
			{ code: 1, stdout: "", stderr: "" }, // rev-parse refs/heads/main:ci.yml — missing
			{ code: 0, stdout: "sha-same\n", stderr: "" }, // rev-parse refs/remotes/origin/main:ci.yml — identical → exempt
			{ code: 0, stdout: "committed", stderr: "" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
	});

	it("pre-push gate: staged workflow file + token WITH workflow scope — push proceeds", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{
				code: 1,
				stdout: ".github/workflows/ci.yml\n",
				stderr: "",
			}, // git diff --cached --name-only
			{
				code: 0,
				stdout: "HTTP/2.0 200 OK\nx-oauth-scopes: repo, read:org, project, workflow\n\n{}",
				stderr: "",
			}, // gh api -i /user — workflow present
			{ code: 0, stdout: "committed", stderr: "" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
	});

	it("pre-push gate: introspection failure — fail-soft, push proceeds (server is ground truth)", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{
				code: 1,
				stdout: ".github/workflows/ci.yml\n",
				stderr: "",
			}, // git diff --cached --name-only
			{ code: 1, stdout: "", stderr: "gh: api call failed" }, // gh api -i /user — non-zero → fail-soft
			{ code: 0, stdout: "committed", stderr: "" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
	});

	it("resolves successfully when git commit returns 'nothing to commit' — calls pushBranch", async () => {
		const { exec, calls } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "", stderr: "" }, // push succeeds
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
		assert.equal(calls.length, 4);
		assert.equal(calls[3].cmd, "git");
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("does not throw when nothing to commit and push succeeds — returns { ok: true }", async () => {
		const { exec, calls } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
	});

	it("returns { ok: false } when git add fails", async () => {
		const { exec } = createMockExec([{ code: 1, stdout: "", stderr: "fatal error" }]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git add failed"));
		}
	});

	it("returns { ok: false } when git commit fails with real error (not 'nothing to commit')", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "fatal: bad config" }, // git commit
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("git commit failed"));
		}
	});

	it("calls pushBranch even when nothing to commit (no short-circuit)", async () => {
		const { exec, calls } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 1, stdout: "", stderr: "nothing to commit" }, // git commit
			{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 4, "should call push even when nothing to commit");
		assert.equal(calls[3].cmd, "git");
		assert.deepEqual(calls[3].args, ["push", "origin", "feature"]);
	});

	it("returns { ok: false } when push fails (after add+commit succeed)", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "", stderr: "" }, // git add
			{ code: 1, stdout: "", stderr: "" }, // git diff --cached --quiet (exit 1 = staged)
			{ code: 0, stdout: "", stderr: "" }, // git commit
			{ code: 1, stdout: "", stderr: "push failed: network error" }, // git push
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(
				result.error.includes("git push failed"),
				`error should mention push: ${result.error}`,
			);
		}
	});
});

// ─── Regression: workflow-scope identical-file exemption (real git) ─────────
// Audit finding rework: the pre-push gate must not abort when the pushed
// workflow content already exists byte-identically on another branch — GitHub
// accepts that without the `workflow` scope (docs exemption).

describe("workflowChangesExempt() — identical-file exemption (real git)", () => {
	it("staged workflow file byte-identical to another branch — exempt (push must not be blocked)", async () => {
		const { dir, cleanup } = await initWorkflowFixture();
		try {
			mkdirSync(join(dir, ".github/workflows"), { recursive: true });
			writeFileSync(join(dir, ".github/workflows/ci.yml"), "v1\n"); // byte-equal to branch `other`
			await realGit(dir, ["add", "."]);
			const exempt = await workflowChangesExempt(realGitExec(dir), dir, [
				".github/workflows/ci.yml",
			]);
			assert.equal(exempt, true);
		} finally {
			cleanup();
		}
	});

	it("staged workflow content changed everywhere — NOT exempt (gate must abort)", async () => {
		const { dir, cleanup } = await initWorkflowFixture();
		try {
			mkdirSync(join(dir, ".github/workflows"), { recursive: true });
			writeFileSync(join(dir, ".github/workflows/ci.yml"), "v2-changed\n");
			await realGit(dir, ["add", "."]);
			const exempt = await workflowChangesExempt(realGitExec(dir), dir, [
				".github/workflows/ci.yml",
			]);
			assert.equal(exempt, false);
		} finally {
			cleanup();
		}
	});
});
