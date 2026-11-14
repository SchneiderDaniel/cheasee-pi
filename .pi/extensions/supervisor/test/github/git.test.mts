// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T>.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commitChanges, pushBranch, workflowScopeHint } from "../../github/git.ts";
import { createMockExec, createMockNotify } from "../helpers/git-harness.mts";

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
