// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.
// All functions return Result<T> for explicit failure handling.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";

// ─── Create Worktree ─────────────────────────────────────────────

/**
 * Reconcile the worktree branch to match the remote tracking branch if one exists.
 *
 * When a worktree is recreated after pipeline cleanup (local branch deleted but
 * remote branch persists), the new local branch may be at defaultBranch HEAD while
 * the remote tracking branch has the developer's actual commits. This function
 * detects that scenario and resets the worktree to match its remote counterpart.
 *
 * Returns Result<void> — never throws. On failure, the caller decides whether
 * reconciliation is fatal (createWorktree treats it as fatal).
 */
export async function reconcileToRemoteBranch(
	pi: ExtensionAPI,
	cwd: string,
	wtPath: string,
	worktreeBranch: string,
	remote: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	const log = getDebugLogger();
	const remoteRef = `refs/remotes/${remote}/${worktreeBranch}`;

	try {
		// Check if remote tracking branch exists
		// rev-parse --verify exits 128 when the ref doesn't exist — pi.exec
		// may throw or return a result, so handle both via try/catch.
		try {
			await pi.exec("git", ["rev-parse", "--verify", remoteRef], { cwd, timeout: 10000 });
		} catch {
			log.info("worktree", `No remote tracking branch ${remote}/${worktreeBranch} — skipping reconciliation`);
			return { ok: true, value: undefined };
		}

		log.info("worktree", `Remote tracking branch ${remote}/${worktreeBranch} exists — reconciling`);

		// Fetch latest from remote for this branch
		await pi.exec(
			"git",
			["fetch", remote, worktreeBranch],
			{ cwd, timeout: 30000 },
		);

		// Reset worktree to match remote tracking branch
		await pi.exec(
			"git",
			["reset", "--hard", `${remote}/${worktreeBranch}`],
			{ cwd: wtPath, timeout: 15000 },
		);

		log.info("worktree", `Worktree reconciled to ${remote}/${worktreeBranch}`);
		notify.info(`Reconciled worktree to remote branch ${remote}/${worktreeBranch}`);
		return { ok: true, value: undefined };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("worktree", `Reconciliation failed: ${msg}`);
		return { ok: false, error: msg, source: "worktree" };
	}
}

export async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
	defaultBranch: string,
	notify: NotifyFn,
): Promise<Result<string>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			const wt = resolvePath(cwd, worktreeBase, worktreeBranch);
			log.info("worktree", `Creating worktree: ${wt}`);

			// Attempt 1: git worktree add -b (creates new branch + worktree)
			try {
				const result = await pi.exec(
					"git",
					["worktree", "add", "-b", worktreeBranch, wt, defaultBranch],
					{ cwd, timeout: 15000 },
				);
				if (result.code !== 0) {
					throw new Error(result.stderr || result.stdout || "git worktree add failed");
				}
				log.info("worktree", `Worktree created at ${wt}`);

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(pi, cwd, wt, worktreeBranch, "origin", notify);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
			} catch (err: unknown) {
				const attempt1Err = err instanceof Error ? err.message : String(err);
				log.warn("worktree", `Attempt 1 failed: ${attempt1Err}`);
			}

			// Attempt 2: branch already exists — try add without -b
			try {
				const result = await pi.exec("git", ["worktree", "add", wt, worktreeBranch], {
					cwd,
					timeout: 15000,
				});
				if (result.code !== 0) {
					throw new Error(result.stderr || result.stdout || "git worktree add failed");
				}
				log.info("worktree", `Worktree attached at ${wt} (existing branch ${worktreeBranch})`);

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(pi, cwd, wt, worktreeBranch, "origin", notify);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
			} catch (err2: unknown) {
				const attempt2Err = err2 instanceof Error ? err2.message : String(err2);
				log.warn("worktree", `Attempt 2 failed: ${attempt2Err}`);
			}

			// Both attempts failed — check if worktree dir somehow exists
			try {
				await pi.exec("test", ["-d", wt], { timeout: 5000 });
				log.warn("worktree", "Both attempts failed but worktree dir exists — using it");

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(pi, cwd, wt, worktreeBranch, "origin", notify);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
			} catch {
				// Directory doesn't exist — throw to stop pipeline early
				const msg = `Failed to create worktree at ${wt} after 2 attempts`;
				log.error("worktree", msg);
				throw new Error(msg);
			}
		},
		notify,
		"worktree",
	);
}

// ponytail: copy git-ignored `.pi/git/` dir into worktree so extensions that
// depend on git-managed packages (ponytail hooks, etc.) can load.
// `.pi/git/` is in .gitignore — git worktree add doesn't copy it.
async function copyGitDir(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<void> {
	const log = getDebugLogger();
	const src = resolvePath(cwd, ".pi/git");
	const dst = resolvePath(worktreePath, ".pi/git");
	try {
		await pi.exec("cp", ["-r", "--preserve=links", src, dst], { timeout: 30_000 });
		log.info("worktree", `Copied .pi/git from ${src} to ${dst}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn("worktree", `Failed to copy .pi/git: ${msg} — continuing without`);
	}
}

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	await copyGitDir(pi, cwd, worktreePath, notify);

	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Installing deps at ${worktreePath}`);

			// Initialize git submodules so agents can edit submodule code too
			// If no submodules exist, command exits 0 silently.
			// If remote is unreachable, warn and continue — agents may still work.
			try {
				await pi.exec("git", ["submodule", "update", "--init", "--recursive"], {
					cwd: worktreePath,
					timeout: 120_000,
				});
				log.info("worktree", "Submodules initialized in worktree");
			} catch (submodErr: unknown) {
				const submodMsg = submodErr instanceof Error ? submodErr.message : String(submodErr);
				log.warn("worktree", `Submodule init failed — continuing: ${submodMsg}`);
			}

			// Attempt 1
			try {
				await pi.exec("npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
				log.info("worktree", "npm ci OK");
				return;
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn("worktree", `npm ci failed (attempt 1): ${errMsg}`);
			}

			// Retry once for transient failures (e.g., network flake, registry timeout)
			try {
				log.info("worktree", "Retrying npm ci...");
				await pi.exec("npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
				log.info("worktree", "npm ci OK on retry");
				return;
			} catch (retryErr: unknown) {
				const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
				log.warn("worktree", `npm ci failed (attempt 2): ${retryMsg}`);
			}

			// Both attempts failed — throw to trigger Result failure
			throw new Error(
				`npm ci failed at ${worktreePath} after 2 attempts — continuing with potentially missing dependencies`,
			);
		},
		notify,
		"worktree",
	);
}

// ─── Delete Branch ───────────────────────────────────────────────

/**
 * Deletes a git branch via `git branch -D`.
 * Extracted from cleanupWorktree so crash-cleanup can run this
 * before the timeout race, preventing orphaned branches.
 * Returns Result<void> — never throws.
 */
export async function deleteBranch(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBranch: string,
): Promise<Result<void>> {
	try {
		await pi.exec("git", ["branch", "-D", worktreeBranch], { cwd, timeout: 10000 });
		return { ok: true, value: undefined };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg, source: "worktree" };
	}
}

// ─── Cleanup Worktree ────────────────────────────────────────────

/**
 * Removes a git worktree and optionally deletes its branch.
 *
 * When `skipBranch` is true, skips `git branch -D` — use when the
 * branch was already deleted via deleteBranch() before the race.
 * Defaults to false for backward compatibility with handler.ts.
 */
export async function cleanupWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	worktreeBranch: string,
	notify: NotifyFn,
	skipBranch?: boolean,
): Promise<Result<void>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Cleaning up worktree: ${worktreePath}, branch: ${worktreeBranch}`);
			await pi.exec("git", ["worktree", "remove", "--force", worktreePath], {
				cwd,
				timeout: 15000,
			});
			await pi.exec("git", ["worktree", "prune"], { cwd, timeout: 15000 });
			log.info("worktree", "Worktree removed");
			if (!skipBranch) {
				await pi.exec("git", ["branch", "-D", worktreeBranch], { cwd, timeout: 10000 });
				log.info("worktree", `Branch ${worktreeBranch} deleted`);
			}
		},
		notify,
		"worktree",
	);
}
