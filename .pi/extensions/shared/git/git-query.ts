// ─── Git queries (shared) ────────────────────────────────────────
// Read-only git probes the goal loop needs before it touches a checkout:
// cleanliness, HEAD, current branch, the worktree registry, writability of the
// worktree base. Extracted with the worktree primitives (issue #2138).

import { accessSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { failure, type Result } from "../result.ts";
import { type ExecLike, GIT_TIMEOUT_MS, runGit } from "./git-exec.ts";

/**
 * True when `git status --porcelain` reports no tracked or untracked changes.
 *
 * A dirty checkout does NOT block `git worktree add` — git creates the
 * worktree from HEAD regardless — so this policy check must be explicit
 * (R3.AC2).
 */
export async function isCheckoutClean(
	exec: ExecLike,
	cwd: string,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<Result<boolean>> {
	const res = await runGit(exec, ["status", "--porcelain"], cwd, timeoutMs);
	if (!res.ok) return res;
	return { ok: true, value: res.value.stdout.trim() === "" };
}

/** Resolve `HEAD` in `cwd` to a full commit sha. */
export async function resolveHead(
	exec: ExecLike,
	cwd: string,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<Result<string>> {
	const res = await runGit(exec, ["rev-parse", "HEAD"], cwd, timeoutMs);
	if (!res.ok) return res;
	const sha = res.value.stdout.trim();
	if (!sha) return failure("git rev-parse HEAD returned an empty sha", "git");
	return { ok: true, value: sha };
}

/** Resolve the branch checked out in `cwd`; a detached HEAD is a failure. */
export async function resolveCurrentBranch(
	exec: ExecLike,
	cwd: string,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<Result<string>> {
	const res = await runGit(exec, ["rev-parse", "--abbrev-ref", "HEAD"], cwd, timeoutMs);
	if (!res.ok) return res;
	const branch = res.value.stdout.trim();
	if (!branch || branch === "HEAD") {
		return failure("original checkout is on a detached HEAD", "git");
	}
	return { ok: true, value: branch };
}

/**
 * Raw `git worktree list --porcelain -z` output. `-z` matters: a worktree path
 * containing a newline survives as one entry. Parse it with
 * `parseWorktreeListPorcelain` from the worktree guard.
 */
export async function listWorktreesPorcelain(
	exec: ExecLike,
	cwd: string,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<Result<string>> {
	const res = await runGit(exec, ["worktree", "list", "--porcelain", "-z"], cwd, timeoutMs);
	if (!res.ok) return res;
	return { ok: true, value: res.value.stdout };
}

/**
 * True when `path` exists and is writable, or does not exist yet under a
 * writable ancestor (`git worktree add` creates leading directories).
 *
 * An existing-but-unwritable directory is a hard no: creating inside it fails.
 */
export function isWritableOrCreatable(path: string): boolean {
	try {
		accessSync(path, fsConstants.W_OK);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
		const parent = dirname(path);
		if (parent === path) return false;
		return isWritableOrCreatable(parent);
	}
}
