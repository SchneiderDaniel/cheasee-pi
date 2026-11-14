/**
 * git-harness.mts — Shared real-git harness and `ExecFn` fakes for the
 * `github/git.ts` suites.
 *
 * `git.test.mts`, `git-part2.test.mts` and `git-part3.test.mts` used to carry a
 * byte-identical 94-line copy of every member below (issue #2105). They live
 * here once so a behavior change only has to be made in one place.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "../../../lib/port-types.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

const execFileP = promisify(execFile);

// ─── Real-git harness (regression: workflow-scope identical-file exemption) ──

/** ExecFn that shells out to real git (mirrors pipeline-worktree-integration). */
export function realGitExec(cwd: string): ExecFn {
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

/** Run real `git <args>` in `dir`, throwing when git exits non-zero. */
export async function realGit(dir: string, args: string[]): Promise<void> {
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
export async function initWorkflowFixture(): Promise<{ dir: string; cleanup: () => void }> {
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

// ─── Scripted fakes ───────────────────────────────────────────────

/** One recorded `ExecFn` invocation. */
export interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

/**
 * Scripted `ExecFn`: returns `results` in call order (then an empty success
 * result) and records every invocation in the returned `calls` array.
 */
export function createMockExec(results: Array<{ code: number; stdout: string; stderr: string }>): {
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

/** `NotifyFn` stub that records each notification with its level. */
export function createMockNotify(): {
	notify: NotifyFn;
	calls: Array<{ level: string; msg: string }>;
} {
	const calls: Array<{ level: string; msg: string }> = [];
	const notify: NotifyFn = {
		info: (msg: string) => calls.push({ level: "info", msg }),
		error: (msg: string) => calls.push({ level: "error", msg }),
	};
	return { notify, calls };
}
