// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.
// All functions return Result<T> for explicit failure handling.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync, constants as fsConstants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { execChecked, withNotify, type Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";

// ─── Create Worktree ─────────────────────────────────────────────

// The removal guard lives in worktree-guard.ts (issue #2001); re-exported
// here so callers keep importing it from this module.
export {
	fetchWorktreeAllowlist,
	parseWorktreeListPorcelain,
	canonicalizePath,
	isStrictlyInside,
	verifyRemovableWorktree,
} from "./worktree-guard.ts";
export type { WorktreeEntry } from "./worktree-guard.ts";

/**
 * Reconcile the worktree to its remote tracking branch and abort on failure.
 *
 * Every createWorktree exit path treats a non-ok reconcile as fatal and only
 * ever reconciles against `origin`; this is the one place that policy lives.
 * Never notifies — the caller's withNotify reports the thrown error once.
 */
async function reconcileOrThrow(
	pi: ExtensionAPI,
	cwd: string,
	wt: string,
	worktreeBranch: string,
	notify: NotifyFn,
): Promise<string> {
	const reconcile = await reconcileToRemoteBranch(pi, cwd, wt, worktreeBranch, "origin", notify);
	if (!reconcile.ok) {
		throw new Error(`Reconciliation failed: ${reconcile.error}`);
	}
	return wt;
}

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

	// Probe the SERVER, not the local tracking ref. A branch deleted on origin
	// leaves a stale refs/remotes/<remote>/<branch> behind (fetch.prune unset),
	// so `rev-parse --verify` said "exists" and the following fetch then died
	// with "couldn't find remote ref" — aborting worktree creation. ls-remote
	// advertises server heads with no pack transfer; empty output = branch gone.
	const lsRemote = await execChecked(
		pi,
		"git",
		["ls-remote", "--heads", remote, `refs/heads/${worktreeBranch}`],
		{ cwd, timeout: 30000 },
	);
	// Best-effort: an unreachable server or an absent branch keeps the local
	// worktree as-is instead of aborting the pipeline on ref-resolution doubt.
	if (lsRemote.code !== 0 || !lsRemote.stdout.trim()) {
		log.info("worktree", `No remote branch ${remote}/${worktreeBranch} — skipping reconciliation`);
		return { ok: true, value: undefined };
	}

	log.info("worktree", `Remote branch ${remote}/${worktreeBranch} exists — reconciling`);

	const fetchRes = await execChecked(pi, "git", ["fetch", remote, worktreeBranch], {
		cwd,
		timeout: 30000,
	});
	if (fetchRes.code !== 0) {
		const msg =
			`git fetch ${remote} ${worktreeBranch} failed: ${fetchRes.stderr || fetchRes.stdout}`.trim();
		log.error("worktree", msg);
		return { ok: false, error: msg, source: "worktree" };
	}

	const resetRes = await execChecked(
		pi,
		"git",
		["reset", "--hard", `${remote}/${worktreeBranch}`],
		{ cwd: wtPath, timeout: 15000 },
	);
	if (resetRes.code !== 0) {
		const msg =
			`git reset --hard ${remote}/${worktreeBranch} failed: ${resetRes.stderr || resetRes.stdout}`.trim();
		log.error("worktree", msg);
		return { ok: false, error: msg, source: "worktree" };
	}

	log.info("worktree", `Worktree reconciled to ${remote}/${worktreeBranch}`);
	notify.info(`Reconciled worktree to remote branch ${remote}/${worktreeBranch}`);
	return { ok: true, value: undefined };
}

/**
 * Resolve the worktree base directory, falling back to a writable location.
 *
 * The configured base (default "../") resolves against the repo cwd and is
 * used as-is when writable or creatable. In the docker deployment the parent
 * of the repo mount (/workspaces) is an image-owned overlay (root:root 755),
 * so `git worktree add` fails with "Permission denied" and the whole pipeline
 * aborts. Probe writability up front and fall back to
 * os.tmpdir()/cheasee-pi-worktrees — the pipeline runs instead of dying.
 *
 * Deterministic: same cwd + configured base + fs state always yields the same
 * result, so the stale-state scanner can re-derive the base the worktree was
 * actually created under.
 */
export function resolveWorktreeBase(
	cwd: string,
	configuredBase: string,
	notify?: NotifyFn,
): string {
	const log = getDebugLogger();
	const base = resolvePath(cwd, configuredBase);
	if (isWritableOrCreatable(base)) {
		return base;
	}
	const fallback = join(tmpdir(), "cheasee-pi-worktrees");
	log.warn("worktree", `Worktree base ${base} is not writable — falling back to ${fallback}`);
	notify?.info(`Worktree base ${base} not writable — using ${fallback} for this pipeline`);
	try {
		mkdirSync(fallback, { recursive: true });
	} catch (err) {
		throw new Error(
			`Worktree base ${base} is not writable and fallback ${fallback} could not be created: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	return fallback;
}

// W_OK on the path itself. Only missing paths (ENOENT) walk up to the
// nearest existing ancestor — git worktree add creates leading dirs, so a
// writable ancestor is enough for those. An existing-but-unwritable dir
// (EACCES, e.g. /workspaces root:root 755) is a hard no: creation inside it
// fails, so the caller must fall back.
function isWritableOrCreatable(path: string): boolean {
	try {
		accessSync(path, fsConstants.W_OK);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const parent = dirname(path);
			if (parent === path) {
				return false;
			}
			return isWritableOrCreatable(parent);
		}
		return false;
	}
}

/**
 * Recover a stale worktree registration before creating a new worktree.
 *
 * A crashed pipeline can leave a registration in .bare/worktrees/<branch>/ with
 * its worktree dir already removed (crash cleanup deleted the dir but not the
 * registration). The entrypoint locks every registration, and `git worktree
 * prune` skips locked entries — so the stale registration blocks BOTH add
 * attempts ("already checked out") and the prune that would fix it. Unlock +
 * prune first, then the normal create flow re-adds cleanly.
 *
 * Never throws. Returns void — failures are logged and the create flow simply
 * runs against the stale state (its own error path reports the failure).
 */
export async function recoverStaleWorktreeRegistration(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
): Promise<void> {
	const log = getDebugLogger();
	const base = resolveWorktreeBase(cwd, worktreeBase);
	const wt = resolvePath(base, worktreeBranch);

	// Only recover when the registration exists but the dir is gone — a live
	// worktree (dir present) must never be pruned out from under a pipeline.
	if (existsSync(wt)) {
		return;
	}

	// Locate the bare repo's admin dir: .bare/worktrees/<branch>/
	const commonDir = await execChecked(pi, "git", ["rev-parse", "--git-common-dir"], {
		cwd,
		timeout: 10000,
	});
	if (commonDir.code !== 0) {
		log.warn("worktree", "Could not resolve git common dir — skipping stale registration recovery");
		return;
	}
	const bareWorktrees = join(commonDir.stdout.trim(), "worktrees");
	const regDir = join(bareWorktrees, worktreeBranch);
	if (!existsSync(regDir)) {
		return; // no stale registration to recover
	}

	log.warn("worktree", `Stale registration ${regDir} (worktree dir missing) — unlocking + pruning`);

	// Remove the lock so prune can drop the dead registration.
	const lockFile = join(regDir, "locked");
	if (existsSync(lockFile)) {
		const unlock = await execChecked(pi, "rm", ["-f", lockFile], { timeout: 5000 });
		if (unlock.code !== 0) {
			log.warn("worktree", `Failed to remove lock file ${lockFile}: ${unlock.stderr}`);
			return;
		}
	}

	const prune = await execChecked(pi, "git", ["worktree", "prune"], { cwd, timeout: 15000 });
	if (prune.code !== 0) {
		log.warn("worktree", `git worktree prune failed during recovery: ${prune.stderr}`);
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
			const base = resolveWorktreeBase(cwd, worktreeBase, notify);
			const wt = resolvePath(base, worktreeBranch);
			log.info("worktree", `Creating worktree: ${wt}`);

			// Recover a stale registration left by a crashed run BEFORE the add
			// attempts — otherwise both fail with "already checked out" while
			// the entrypoint's lock blocks the prune that would fix it.
			await recoverStaleWorktreeRegistration(pi, cwd, worktreeBase, worktreeBranch);

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

				// await: keeps a reconcile rejection inside this try so the catch
				// can fall through to attempt 2 (returning the bare promise would
				// let the rejection escape the catch).
				return await reconcileOrThrow(pi, cwd, wt, worktreeBranch, notify);
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

				return await reconcileOrThrow(pi, cwd, wt, worktreeBranch, notify);
			} catch (err2: unknown) {
				const attempt2Err = err2 instanceof Error ? err2.message : String(err2);
				log.warn("worktree", `Attempt 2 failed: ${attempt2Err}`);
			}

			// Both attempts failed — check if worktree dir somehow exists.
			// Check result.code explicitly: pi.exec resolves {code} on non-zero
			// exit (never rejects), so the old try/catch treated a missing dir
			// as "exists" and the pipeline ran against a nonexistent worktree.
			const testRes = await execChecked(pi, "test", ["-d", wt], { timeout: 5000 });
			if (testRes.code !== 0) {
				const msg = `Failed to create worktree at ${wt} after 2 attempts`;
				log.error("worktree", msg);
				throw new Error(msg);
			}
			log.warn("worktree", "Both attempts failed but worktree dir exists — using it");

			return await reconcileOrThrow(pi, cwd, wt, worktreeBranch, notify);
		},
		notify,
		"worktree",
	);
}

// Dependency/cleanup helpers extracted to worktree-deps.ts (issue #2005).
// Explicit named re-exports keep the worktree surface stable.
export {
	cleanupWorktree,
	deleteBranch,
	installWorktreeDeps,
	linkWorktreeVenvs,
} from "./worktree-deps.ts";
