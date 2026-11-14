// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T>.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../../lib/port-types.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { commitAndPush } from "../../github/git.ts";
import { createMockExec, createMockNotify } from "../helpers/git-harness.mts";

// ─── Tests: commitChanges() ───────────────────────────────────────

// Split from git.test.mts (issue #2035 Long File refactor).
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
				stdout: "sha-main\trefs/heads/main\nsha-other\trefs/heads/other\n",
				stderr: "",
			}, // ls-remote --heads origin — server heads
			{
				code: 0,
				stdout: "sha-main refs/remotes/origin/main\nsha-other refs/remotes/origin/other\n",
				stderr: "",
			}, // for-each-ref refs/remotes/origin — coverage authoritative
			{ code: 0, stdout: "sha-new\n", stderr: "" }, // rev-parse :ci.yml (staged blob)
			{ code: 1, stdout: "", stderr: "" }, // rev-parse origin/main:ci.yml — missing
			{ code: 1, stdout: "", stderr: "" }, // rev-parse origin/other:ci.yml — missing
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
				stdout: "sha-main\trefs/heads/main\nsha-other\trefs/heads/other\n",
				stderr: "",
			}, // ls-remote --heads origin
			{
				code: 0,
				stdout: "sha-main refs/remotes/origin/main\nsha-other refs/remotes/origin/other\n",
				stderr: "",
			}, // for-each-ref refs/remotes/origin — coverage authoritative
			{ code: 0, stdout: "sha-same\n", stderr: "" }, // rev-parse :ci.yml (staged blob)
			{ code: 1, stdout: "", stderr: "" }, // rev-parse origin/main:ci.yml — missing
			{ code: 0, stdout: "sha-same\n", stderr: "" }, // rev-parse origin/other:ci.yml — identical → exempt
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

	it("pre-push gate: identical workflow exists on a server branch absent locally — fail-soft, push proceeds (no false abort)", async () => {
		// Branch `remoteonly` was created on the server since the last fetch:
		// ls-remote lists it but refs/remotes/origin has no match → local
		// coverage is not authoritative → the gate must NOT abort (the server
		// might accept under the identical-file exemption).
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
				stdout:
					"sha-main\trefs/heads/main\nsha-other\trefs/heads/other\nsha-r\trefs/heads/remoteonly\n",
				stderr: "",
			}, // ls-remote --heads origin — remoteonly unseen locally
			{
				code: 0,
				stdout: "sha-main refs/remotes/origin/main\nsha-other refs/remotes/origin/other\n",
				stderr: "",
			}, // for-each-ref — stale coverage (remoteonly missing)
			{ code: 0, stdout: "committed", stderr: "" }, // git commit — proceed
			{ code: 0, stdout: "", stderr: "" }, // git push — server decides
		]);
		const { notify } = createMockNotify();
		const result = await commitAndPush(exec, "/tmp/worktree", "origin", "feature", "msg", notify);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, true);
		}
	});

	it("pre-push gate: ref-resolution ExecFn rejection — fail-soft, push proceeds (gate never throws)", async () => {
		// Audit regression: a subprocess timeout / rejected ExecFn during the
		// exemption check must be converted to null and the real push attempted.
		let callIdx = 0;
		const exec: ExecFn = async (cmd: string, args: string[]): Promise<ExecResult> => {
			callIdx++;
			if (callIdx === 4) throw new Error("mock exec timeout"); // ls-remote
			switch (callIdx) {
				case 1:
					return { code: 0, stdout: "", stderr: "", killed: false }; // git add -A
				case 2:
					return {
						code: 1,
						stdout: ".github/workflows/ci.yml\n",
						stderr: "",
						killed: false,
					}; // git diff --cached --name-only
				case 3:
					return {
						code: 0,
						stdout: "HTTP/2.0 200 OK\nx-oauth-scopes: repo, read:org, project\n\n{}",
						stderr: "",
						killed: false,
					}; // gh api -i /user — token lacks workflow
				default:
					return { code: 0, stdout: "committed", stderr: "", killed: false }; // commit + push
			}
		};
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
