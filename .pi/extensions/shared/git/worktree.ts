// ─── Git worktree primitives: create and remove (shared) ─────────
// Extracted from supervisor/pipeline/worktree.ts (issue #2138) so the goal-loop
// extension and the Supervisor issue identical git argv.
//
// Only the mutating primitives live here. Supervisor-specific policy —
// defaultBranch selection, remote reconciliation, stale-registration recovery,
// the tmpdir fallback — stays in `supervisor/pipeline/worktree.ts`. The goal
// loop refuses that fallback: its worktrees start at the original checkout's
// HEAD and must survive a container restart.

import { type ExecLike, GIT_TIMEOUT_MS, runGit } from "./git-exec.ts";
import type { Result } from "../result.ts";

export type { ExecLike, ExecOutcome } from "./git-exec.ts";

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
