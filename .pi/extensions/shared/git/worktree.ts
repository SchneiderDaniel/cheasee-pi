// ─── Git worktree primitives (shared) ────────────────────────────
// Extracted from supervisor/pipeline/worktree.ts (issue #2138) so the
// goal-loop extension and the Supervisor issue the identical git commands.
//
// Only primitives live here. Supervisor-specific policy — defaultBranch
// selection, remote reconciliation, stale-registration recovery, the tmpdir
// fallback — stays in `supervisor/pipeline/worktree.ts`. The goal loop
// deliberately refuses the tmpdir fallback and never reconciles to a remote:
// its worktrees start at the original checkout's HEAD and must survive a
// container restart.

import type { ExecOptions } from "@earendil-works/pi-coding-agent";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { failure, type Result } from "../result.ts";

/**
 * The exec result this module needs. Structurally narrower than Pi's
 * `ExecResult` so any exec port (Pi's `pi.exec`, the test harness's `ExecFn`)
 * is accepted without a cast.
 */
export interface ExecOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

/** The injected exec port: `pi.exec.bind(pi)` in production. */
export type ExecLike = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecOutcome>;

/** Default git command timeout for worktree operations (ms). */
const GIT_TIMEOUT_MS = 15_000;

/** Run one git command, normalizing a rejecting exec into a failed Result. */
async function runGit(
	exec: ExecLike,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<Result<ExecOutcome>> {
	try {
		const res = await exec("git", args, { cwd, timeout: timeoutMs });
		if (res.code !== 0) {
			return failure(res.stderr || res.stdout || `git ${args[0]} failed`, "git");
		}
		return { ok: true, value: res };
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), "git");
	}
}

export interface AddWorktreeInput {
	/** Repository to run `git worktree add` in. */
	cwd: string;
	/** Absolute path of the new worktree. */
	path: string;
	/** Branch to create (createBranch) or attach (otherwise). */
	branch: string;
	/** Start point for a new branch. Ignored when `createBranch` is false. */
	startPoint: string;
	/** Create the branch from `startPoint` (`-b`). Defaults to true. */
	createBranch?: boolean;
	timeoutMs?: number;
}

/**
 * Create a worktree.
 *
 * With `createBranch` (the default) the argv is exactly
 * `git worktree add -b <branch> <path> <startPoint>`, which creates the branch
 * and the worktree atomically. Otherwise the argv is
 * `git worktree add <path> <branch>` and `startPoint` is unused.
 *
 * Returns the worktree path on success, or git's own stderr on failure.
 */
export async function addWorktree(
	exec: ExecLike,
	input: AddWorktreeInput,
): Promise<Result<string>> {
	const createBranch = input.createBranch ?? true;
	const args = createBranch
		? ["worktree", "add", "-b", input.branch, input.path, input.startPoint]
		: ["worktree", "add", input.path, input.branch];
	const res = await runGit(exec, args, input.cwd, input.timeoutMs ?? GIT_TIMEOUT_MS);
	if (!res.ok) return res;
	return { ok: true, value: input.path };
}

export interface RemoveWorktreeInput {
	/** Repository whose worktree registry is updated. */
	cwd: string;
	/** Absolute path of the worktree to remove. */
	path: string;
	/** Pass `--force` so a dirty worktree is removable on explicit request. */
	force?: boolean;
	timeoutMs?: number;
}

/**
 * Remove a worktree registration and its directory.
 *
 * `git worktree remove` is the only real deletion; a plain `rm -rf` leaves the
 * registration behind and the branch "checked out". Callers must have verified
 * the path through `verifyRemovableWorktree` first.
 */
export async function removeWorktree(
	exec: ExecLike,
	input: RemoveWorktreeInput,
): Promise<Result<void>> {
	const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path];
	const res = await runGit(exec, args, input.cwd, input.timeoutMs ?? GIT_TIMEOUT_MS);
	if (!res.ok) return res;
	return { ok: true, value: undefined };
}

/**
 * True when `git status --porcelain` reports no tracked or untracked changes.
 *
 * A dirty checkout does NOT block `git worktree add` — git creates the
 * worktree from HEAD regardless — so this policy check must be explicit.
 */
export async function isCheckoutClean(
	exec: ExecLike,
	cwd: string,
	timeoutMs = 15_000,
): Promise<Result<boolean>> {
	const res = await runGit(exec, ["status", "--porcelain"], cwd, timeoutMs);
	if (!res.ok) return res;
	return { ok: true, value: res.value.stdout.trim() === "" };
}

/** Resolve `HEAD` in `cwd` to a full commit sha. */
export async function resolveHead(
	exec: ExecLike,
	cwd: string,
	timeoutMs = 15_000,
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
	timeoutMs = 15_000,
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
	timeoutMs = 15_000,
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
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const parent = dirname(path);
			if (parent === path) return false;
			return isWritableOrCreatable(parent);
		}
		return false;
	}
}
