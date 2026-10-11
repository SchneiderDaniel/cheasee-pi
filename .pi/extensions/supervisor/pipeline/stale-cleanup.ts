// ─── Stale Pipeline State Cleanup ─────────────────────────────────
// Startup cleanup of crash-orphaned state checkpoints + their worktrees.
// Split out of state-checkpoint.ts (issue #2001); re-exported from there.

import { existsSync, unlinkSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import type { Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../config/types.ts";
import { resolveWorktreeBase } from "./worktree.ts";
import {
	fetchWorktreeAllowlist,
	verifyRemovableWorktree,
	type WorktreeEntry,
} from "./worktree-guard.ts";
import {
	findStateFiles,
	isStaleCheckpoint,
	readCheckpointFileFromPath,
	stateFilesInPiDir,
} from "./checkpoint-file.ts";
import { pidAlive, readRunLock, runLockPath } from "./run-lock.ts";

/**
 * Scan for stale supervisor state checkpoint files and clean up their worktrees.
 *
 * Searches in two locations:
 * 1. The main repo's `.pi/` (per-issue files + legacy bare-name)
 * 2. All worktree subdirectories under `worktreeBase` that contain `.pi/supervisor-state*.json`
 *
 * For each stale checkpoint (age > maxAgeMs), removes the worktree and branch.
 * - Wraps each git command in try-catch so failure of one doesn't block others.
 * - Skips self-cleanup: never cleans a checkpoint whose `worktreePath` matches `currentWorktreePath`.
 * - Removal guard: `state.worktreePath` comes from an agent-writable repo-local
 *   JSON file, so it is only removed when `verifyRemovableWorktree` proves it
 *   is inside the worktree base *and* a registered linked worktree. A refused
 *   path logs a warning and leaves its state file for manual cleanup.
 * - Already-gone worktree: when `state.worktreePath` no longer exists on disk,
 *   the stale state file is dropped without an error and without running the
 *   removal steps — this is checked *before* the removal guard because a locked
 *   registration survives a missing directory (`git worktree prune` skips
 *   locked entries), so the guard would otherwise pass and `git worktree remove`
 *   would fail with "is not a working tree" on every run.
 * - Liveness guard: never cleans a checkpoint whose per-issue run lock is held
 *   by a DIFFERENT live process — with per-issue parallelism, run B's preflight
 *   must not prune run A's live worktree just because A's last checkpoint is
 *   >1h old. Own-PID locks don't protect (acquireRunLock already wrote our pid
 *   by the time this runs), so a same-issue rerun after a crash still prunes the
 *   orphaned worktree. The lock lives in the main repo `.pi/`, so it survives
 *   partial worktree removal (the `recoverStaleWorktreeRegistration` scenario
 *   stays covered). A dead-PID lock does not protect — the crash case still cleans.
 * - Non-blocking: if cleanup of one stale checkpoint fails, logs warning and continues to the next.
 * - Runs `git worktree prune` before `git worktree remove --force` so git admin data is synced.
 * - `fs.rmSync` fallback for the worktree directory, and only after
 *   `git worktree remove` reported success — an untrusted path never reaches
 *   argv, and a refused removal never falls back to a raw recursive delete.
 * - `git branch -D` only runs for the branch the matched worktree is actually
 *   registered on (and never for a detached entry) — the state file's branch
 *   name cannot delete an unrelated branch. `git worktree prune` and
 *   `git branch -D` non-zero exits are surfaced as warnings (prune is
 *   non-blocking); a failed branch delete retains the state file.
 *
 * @param pi - ExtensionAPI for git commands
 * @param cwd - Repository root directory
 * @param config - Supervisor config (for worktreeBase)
 * @param notify - Notification callbacks
 * @param currentWorktreePath - Current pipeline's worktree path (to skip self-cleanup, optional)
 * @returns Result<void> — ok=true always (best-effort cleanup, errors are warnings)
 */
export async function cleanupStalePipelineState(
	pi: ExtensionAPI,
	cwd: string,
	config: SupervisorConfig,
	notify: NotifyFn,
	currentWorktreePath?: string,
): Promise<Result<void>> {
	const log = getDebugLogger();
	const worktreeBase = config.worktreeBase;
	if (!worktreeBase) {
		log.info("state-checkpoint", "No worktreeBase configured — skipping stale state cleanup");
		return { ok: true, value: undefined };
	}

	// Resolve the base the worktrees actually live under — same derivation
	// createWorktree uses, so stale-state scanning follows the tmpdir fallback
	// when the configured base is not writable (docker /workspaces overlay).
	const baseDir = resolveWorktreeBase(cwd, worktreeBase, notify);

	// Collect all supervisor-state*.json files to check
	const stateFiles: string[] = [];

	// 1. Check main repo's .pi/ (per-issue + legacy bare-name)
	stateFiles.push(...stateFilesInPiDir(resolve(cwd, ".pi")));

	// 2. Scan worktree directories for state files
	if (existsSync(baseDir)) {
		const found = findStateFiles(baseDir);
		// Deduplicate — main state files already added
		for (const f of found) {
			if (!stateFiles.includes(f)) {
				stateFiles.push(f);
			}
		}
	}

	if (stateFiles.length === 0) {
		log.info("state-checkpoint", "No supervisor-state*.json files found — no stale state to clean");
		return { ok: true, value: undefined };
	}

	let anyError = false;
	const warnings: string[] = [];

	// The linked-worktree allowlist is fetched at most once per cleanup run,
	// and only when a stale checkpoint actually reaches the removal guard.
	let allowlist: WorktreeEntry[] | null = null;
	const getAllowlist = async (): Promise<WorktreeEntry[]> => {
		if (allowlist === null) {
			const fetched = await fetchWorktreeAllowlist(pi, cwd);
			if (!fetched.ok) {
				log.warn(
					"state-checkpoint",
					`Could not read worktree allowlist (${fetched.error}) — skipping all removals`,
				);
			}
			allowlist = fetched.ok ? fetched.value : [];
		}
		return allowlist;
	};

	for (const stateFile of stateFiles) {
		const state = readCheckpointFileFromPath(stateFile);
		if (!state) {
			// Parse error or missing fields — skip this file (leave it for manual cleanup)
			log.warn("state-checkpoint", `Skipping unparseable state file: ${stateFile}`);
			continue;
		}

		// Skip self-cleanup: don't clean the current pipeline's own worktree
		if (currentWorktreePath && state.worktreePath === currentWorktreePath) {
			log.info("state-checkpoint", "Skipping self-cleanup for current pipeline's worktree", {
				worktreePath: currentWorktreePath,
			});
			continue;
		}

		// Check staleness
		if (!isStaleCheckpoint(state)) {
			log.info("state-checkpoint", "Checkpoint not stale — skipping cleanup", {
				issueNum: state.issueNum,
				startedAt: state.startedAt,
			});
			continue;
		}

		// Liveness guard: a DIFFERENT live process owns this issue's worktree.
		// Never prune it — even a >1h-old checkpoint must not let run B remove
		// run A's live worktree. Own-PID locks (acquireRunLock runs before this
		// cleanup in the handler, so our own lock holds process.pid) do NOT
		// protect: a same-issue rerun after a crash must still prune the
		// orphaned worktree left by the dead run. Dead-PID locks also clean.
		const issueLock = readRunLock(runLockPath(cwd, state.issueNum));
		if (issueLock && issueLock.pid !== process.pid && pidAlive(issueLock.pid)) {
			log.info("state-checkpoint", "Skipping cleanup — issue has a live pipeline", {
				issueNum: state.issueNum,
				pid: issueLock.pid,
			});
			continue;
		}

		// ── Stale checkpoint — verify before any destructive step ──
		// The state file is agent-writable, so removing a path it names is only
		// safe once the path is proven to be a registered worktree inside the
		// worktree base. Anything unverifiable is skipped and left in place.
		const verdict = verifyRemovableWorktree(
			await getAllowlist(),
			cwd,
			baseDir,
			state.worktreePath,
			config.defaultBranch,
		);
		// The worktree this stale state file names is already gone — cleanup
		// finished but the state-file unlink never ran (the owning pipeline died
		// between `git worktree remove` and the unlink, or the worktree was
		// removed out-of-band). Nothing is left to clean, so this is not an
		// error: the stale JSON is garbage and can be deleted instead of erroring
		// on every later run. Safe — the liveness guard above already proved the
		// owning pipeline dead, and the success path deletes this exact file
		// anyway.
		//
		// Checked BEFORE the verification verdict, not inside its failure branch:
		// a registration whose directory is gone still survives when it is locked
		// (entrypoint.sh locks every worktree and `git worktree prune` skips locked
		// entries), so the allowlist still lists the path, the guard passes, and
		// `git worktree remove` then fails with "is not a working tree" — leaving
		// the state file in place and erroring on every later run. A directory
		// that still exists (unverifiable path, outside base, bare repo, ...)
		// stays fail-closed: error + keep the file below.
		if (!existsSync(state.worktreePath)) {
			log.info("state-checkpoint", "Stale state file dropped — worktree already gone", {
				issueNum: state.issueNum,
				worktreePath: state.worktreePath,
			});
			notify.info(
				`Stale state file for issue #${state.issueNum} removed — its worktree was already cleaned up`,
			);
			try {
				if (existsSync(stateFile)) {
					unlinkSync(stateFile);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn("state-checkpoint", `Failed to delete stale state file: ${msg}`);
				warnings.push(`state file delete failed: ${msg}`);
			}
			continue;
		}

		if (!verdict.ok) {
			log.warn("state-checkpoint", "Skipping cleanup — unverified worktree path", {
				issueNum: state.issueNum,
				worktreePath: state.worktreePath,
				reason: verdict.error,
			});
			notify.error(
				`Skipping stale worktree cleanup for issue #${state.issueNum}: ${verdict.error}. Remove ${stateFile} manually if it is stale.`,
			);
			continue;
		}
		const removePath = verdict.value.path;
		// The branch the matched worktree is registered on — the only branch that
		// may be deleted. `state.worktreeBranch` is untrusted and cannot be used
		// on its own (a forged file could name a real worktree and an unrelated
		// branch). null = detached/bare → no branch deletion.
		const registeredBranch = verdict.value.branch;

		notify.info(`Cleaning up stale worktree from issue #${state.issueNum} at ${removePath}`);
		log.info("state-checkpoint", "Cleaning up stale worktree", {
			issueNum: state.issueNum,
			worktreePath: removePath,
			branch: state.worktreeBranch,
			checkpoint: state.checkpoint,
		});

		// Step 1: git worktree prune — sync admin state first. Non-blocking for the
		// removal that follows, but a non-zero exit must reach the caller: pi.exec
		// resolves {code} on failure (never rejects), so an ignored code silently
		// hides a failed prune behind a success result.
		try {
			const pruneRes = await pi.exec("git", ["worktree", "prune"], { cwd, timeout: 15000 });
			if (pruneRes.code !== 0) {
				const msg = pruneRes.stderr || pruneRes.stdout || "git worktree prune failed";
				log.warn("state-checkpoint", `git worktree prune failed: ${msg}`);
				warnings.push(`prune failed: ${msg}`);
				anyError = true;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `git worktree prune failed: ${msg}`);
			warnings.push(`prune failed: ${msg}`);
			anyError = true;
		}

		// Step 2: git worktree remove --force --force (double force overrides
		// the entrypoint.sh lock — single --force refuses locked worktrees)
		let removed = false;
		try {
			const removeRes = await pi.exec(
				"git",
				["worktree", "remove", "--force", "--force", removePath],
				{
					cwd,
					timeout: 15000,
				},
			);
			if (removeRes.code !== 0) {
				throw new Error(removeRes.stderr || removeRes.stdout || "git worktree remove failed");
			}
			removed = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `git worktree remove --force --force failed: ${msg}`);
			warnings.push(`remove failed: ${msg}`);
		}
		if (!removed) {
			// Registration is stale but git refused the removal — the recursive
			// delete or a branch deletion here could destroy live state, so leave
			// everything (state file included) for manual cleanup.
			notify.error(
				`Could not remove stale worktree ${removePath} (issue #${state.issueNum}) — leaving it and its state file in place`,
			);
			continue;
		}

		// Step 3: git branch -D — only the branch the verifier saw registered on
		// this worktree. `--` so a branch named like an option is not parsed.
		// A detached entry has no branch, and a state branch that does not match
		// the registration is forged or stale: skip, never delete.
		let branchFailed = false;
		if (registeredBranch === null) {
			const msg = `branch delete skipped: worktree ${removePath} is detached`;
			log.warn("state-checkpoint", msg);
			warnings.push(msg);
		} else if (registeredBranch !== `refs/heads/${state.worktreeBranch}`) {
			const msg = `branch delete skipped: state names ${state.worktreeBranch}, worktree is registered on ${registeredBranch}`;
			log.warn("state-checkpoint", msg);
			warnings.push(msg);
		} else {
			try {
				const branchRes = await pi.exec("git", ["branch", "-D", "--", state.worktreeBranch], {
					cwd,
					timeout: 10000,
				});
				if (branchRes.code !== 0) {
					throw new Error(branchRes.stderr || branchRes.stdout || "git branch -D failed");
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn("state-checkpoint", `git branch -D failed: ${msg}`);
				warnings.push(`branch delete failed: ${msg}`);
				branchFailed = true;
				notify.error(
					`Failed to delete stale branch ${state.worktreeBranch} (issue #${state.issueNum}): ${msg}`,
				);
			}
		}
		if (branchFailed) {
			anyError = true;
		}

		// Step 4: recursive delete fallback for leftover files. fs.rmSync, not
		// `pi.exec("rm", ...)` — the path is untrusted and must never reach argv.
		try {
			rmSync(removePath, { recursive: true, force: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `rm fallback failed: ${msg}`);
			warnings.push(`rm fallback failed: ${msg}`);
		}

		// Step 5: Delete the state file itself — but never when a required step
		// failed. A retained state file keeps the unfinished cleanup visible for
		// manual handling instead of reporting success over a live stale branch.
		if (branchFailed) {
			notify.error(
				`Retaining ${stateFile} — stale worktree cleanup for issue #${state.issueNum} did not complete`,
			);
		} else {
			try {
				if (existsSync(stateFile)) {
					unlinkSync(stateFile);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn("state-checkpoint", `Failed to delete stale state file: ${msg}`);
				warnings.push(`state file delete failed: ${msg}`);
			}
		}

		if (!branchFailed) {
			notify.info(`Cleaned up stale worktree from issue #${state.issueNum}`);
			log.info("state-checkpoint", "Stale worktree cleanup complete", {
				issueNum: state.issueNum,
				worktreePath: removePath,
			});
		}
	}

	// If all state files had errors, return failure
	// But individual failures should not block the pipeline
	if (anyError || warnings.length > 0) {
		if (anyError) {
			return { ok: false, error: warnings.join("; "), source: "state-checkpoint" };
		}
		return { ok: true, value: undefined };
	}

	return { ok: true, value: undefined };
}
