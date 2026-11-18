// ─── Git goal workspace ──────────────────────────────────────────
// Adapter: the clean-checkout gate, the HEAD-based worktree and the confirmed
// cleanup. All git argv comes from `shared/git/`, and cleanup
// re-verifies the target with the Supervisor's removal guard
// (`verifyRemovableWorktree`) — the goal loop never deletes a path it cannot
// prove is a registered linked worktree inside its own base.
//
// Deliberate differences from Supervisor's `createWorktree` (R3):
// - the start point is the ORIGINAL CHECKOUT'S `HEAD`, not the default branch;
// - no remote reconciliation (`git reset --hard` would discard goal commits);
// - no tmpdir fallback — an unwritable base fails closed, because a worktree in
//   `os.tmpdir()` is lost on container restart and the goal could never resume.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { failure, type Result } from "../../shared/result.ts";
import { addWorktree, removeWorktree, type ExecLike } from "../../shared/git/worktree.ts";
import {
	isCheckoutClean,
	isWritableOrCreatable,
	listWorktreesPorcelain,
	resolveCurrentBranch,
	resolveHead,
} from "../../shared/git/git-query.ts";
import {
	parseWorktreeListPorcelain,
	verifyRemovableWorktree,
} from "../../shared/git/worktree-guard.ts";
import type {
	GoalWorkspace,
	PrepareWorkspaceInput,
	WorkspaceOutcome,
} from "../application/ports.ts";

const SOURCE = "goal-workspace";

export interface GitGoalWorkspaceOptions {
	/** Root of the original checkout — every git command runs here. */
	checkoutRoot: string;
	/** Directory that holds goal worktrees. Must be writable; no fallback. */
	worktreeBase: string;
	/** `pi.exec` bound to the extension API. */
	exec: ExecLike;
}

/**
 * Git-backed {@link GoalWorkspace}.
 *
 * One worktree per goal, based on the original checkout's `HEAD` (R3.AC2).
 */
export class GitGoalWorkspace implements GoalWorkspace {
	private readonly checkoutRoot: string;
	private readonly worktreeBase: string;
	private readonly exec: ExecLike;

	constructor(options: GitGoalWorkspaceOptions) {
		this.checkoutRoot = options.checkoutRoot;
		this.worktreeBase = options.worktreeBase;
		this.exec = options.exec;
	}

	/** Absolute worktree path for `goalId`. */
	worktreePathFor(goalId: string): string {
		return join(this.worktreeBase, goalId);
	}

	/**
	 * Refuse a dirty or detached checkout, then create the worktree from `HEAD`.
	 *
	 * The cleanliness check is explicit: `git worktree add` happily creates a
	 * worktree from `HEAD` while the main checkout is dirty, so an unchecked
	 * start would silently split the user's work.
	 */
	async prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceOutcome>> {
		const clean = await isCheckoutClean(this.exec, this.checkoutRoot);
		if (!clean.ok) {
			return failure(`cannot inspect the current checkout: ${clean.error}`, SOURCE);
		}
		if (!clean.value) {
			return {
				ok: true,
				value: {
					clean: false,
					reason:
						"the current checkout has uncommitted changes — commit or stash them before starting a goal",
				},
			};
		}

		const branch = await resolveCurrentBranch(this.exec, this.checkoutRoot);
		if (!branch.ok) {
			return {
				ok: true,
				value: {
					clean: false,
					reason: `cannot start a goal from this checkout: ${branch.error} (check out a branch first)`,
				},
			};
		}

		const head = await resolveHead(this.exec, this.checkoutRoot);
		if (!head.ok) {
			return failure(`cannot resolve HEAD: ${head.error}`, SOURCE);
		}

		if (!isWritableOrCreatable(this.worktreeBase)) {
			return failure(
				`worktree base ${this.worktreeBase} is not writable — goal worktrees need a durable base ` +
					"(no temporary-directory fallback)",
				SOURCE,
			);
		}
		try {
			mkdirSync(this.worktreeBase, { recursive: true });
		} catch (err: unknown) {
			return failure(
				`cannot create worktree base ${this.worktreeBase}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				SOURCE,
			);
		}

		const path = this.worktreePathFor(input.goalId);
		const added = await addWorktree(this.exec, {
			cwd: this.checkoutRoot,
			path,
			branch: input.branch,
			startPoint: head.value,
			createBranch: true,
		});
		if (!added.ok) {
			return failure(`git worktree add failed: ${added.error}`, SOURCE);
		}
		return { ok: true, value: { clean: true, path, branch: input.branch, head: head.value } };
	}

	/**
	 * Remove the worktree (R3.AC5).
	 *
	 * Without `confirmed` this is a refusal — the worktree and branch stay until
	 * the user explicitly asks. The removal itself is gated by the shared
	 * removal guard, so a tampered record path cannot delete the checkout.
	 */
	async cleanupWorktree(input: { path: string; confirmed: boolean }): Promise<Result<void>> {
		if (!input.confirmed) {
			return failure(
				`worktree ${input.path} retained — run /goal cleanup --confirm to remove it`,
				SOURCE,
			);
		}

		const listed = await listWorktreesPorcelain(this.exec, this.checkoutRoot);
		if (!listed.ok) {
			return failure(`cannot list worktrees: ${listed.error}`, SOURCE);
		}
		const entries = parseWorktreeListPorcelain(listed.value);
		const verified = verifyRemovableWorktree(
			entries,
			this.checkoutRoot,
			this.worktreeBase,
			input.path,
		);
		if (!verified.ok) {
			return failure(`refusing to remove ${input.path}: ${verified.error}`, SOURCE);
		}

		const removed = await removeWorktree(this.exec, {
			cwd: this.checkoutRoot,
			path: verified.value.path,
			force: true,
		});
		if (!removed.ok) {
			return failure(`git worktree remove failed: ${removed.error}`, SOURCE);
		}
		return { ok: true, value: undefined };
	}
}
