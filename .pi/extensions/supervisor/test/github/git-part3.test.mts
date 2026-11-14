// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T>.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn } from "../../../lib/port-types.ts";
import { workflowChangesExempt } from "../../github/git.ts";
import { initWorkflowFixture, realGit, realGitExec } from "../helpers/git-harness.mts";

// ─── Tests: commitChanges() ───────────────────────────────────────

// Split from git.test.mts (issue #2035 Long File refactor).
describe("workflowChangesExempt() — identical-file exemption (real git)", () => {
	it("staged workflow file byte-identical to another branch — exempt (push must not be blocked)", async () => {
		const { dir, cleanup } = await initWorkflowFixture();
		try {
			mkdirSync(join(dir, ".github/workflows"), { recursive: true });
			writeFileSync(join(dir, ".github/workflows/ci.yml"), "v1\n"); // byte-equal to branch `other` on origin
			await realGit(dir, ["add", "."]);
			const exempt = await workflowChangesExempt(realGitExec(dir), dir, "origin", [
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
			const exempt = await workflowChangesExempt(realGitExec(dir), dir, "origin", [
				".github/workflows/ci.yml",
			]);
			assert.equal(exempt, false);
		} finally {
			cleanup();
		}
	});

	it("identical workflow on a server branch missing locally — fail-soft null, no false abort", async () => {
		// Audit regression: branch `remoteonly` exists on origin (created since
		// the last fetch) but has no local refs/remotes/origin counterpart —
		// local coverage is not authoritative, so the gate must return null
		// (real push decides) instead of false (which would abort the push).
		const { dir, cleanup } = await initWorkflowFixture();
		try {
			const origin = join(dir, "..", "origin.git");
			const otherSha = (
				await realGitExec(dir)("git", ["rev-parse", "other"], { cwd: dir })
			).stdout.trim();
			await realGit(origin, ["update-ref", "refs/heads/remoteonly", otherSha]);

			mkdirSync(join(dir, ".github/workflows"), { recursive: true });
			writeFileSync(join(dir, ".github/workflows/ci.yml"), "v1\n"); // identical to `other` and `remoteonly`
			await realGit(dir, ["add", "."]);
			const exempt = await workflowChangesExempt(realGitExec(dir), dir, "origin", [
				".github/workflows/ci.yml",
			]);
			assert.equal(exempt, null);
		} finally {
			cleanup();
		}
	});

	it("ExecFn rejection — returns null (never throws; gate fail-soft)", async () => {
		// Audit regression: a subprocess timeout / rejected ExecFn during ref
		// resolution must be converted to null, not propagate.
		const throwingExec: ExecFn = async () => {
			throw new Error("mock exec timeout");
		};
		const exempt = await workflowChangesExempt(throwingExec, "/tmp/worktree", "origin", [
			".github/workflows/ci.yml",
		]);
		assert.equal(exempt, null);
	});
});
