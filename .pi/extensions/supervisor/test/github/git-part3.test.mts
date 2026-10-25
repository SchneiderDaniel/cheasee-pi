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
import { workflowChangesExempt } from "../../github/git.ts";
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
