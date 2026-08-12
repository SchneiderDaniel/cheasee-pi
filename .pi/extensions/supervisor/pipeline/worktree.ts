// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.
// All functions return Result<T> for explicit failure handling.

import type { ExtensionAPI, ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { accessSync, constants as fsConstants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";

// ─── Create Worktree ─────────────────────────────────────────────

// ─── Exec Contract Normalization ─────────────────────────────────
// pi.exec resolves {code} even on non-zero exit — it never rejects. Some
// mocks/tests reject instead. Normalize both contracts so callers can check
// `.code` unconditionally; a silent success lets a failed worktree command
// pass as ok (the broken fallback that produced the "Worktree missing"
// cascade when `git worktree add` failed on an unwritable base dir).
async function execChecked(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	opts?: ExecOptions,
): Promise<ExecResult> {
	try {
		return await pi.exec(cmd, args, opts);
	} catch (err: unknown) {
		return {
			code: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			killed: false,
		};
	}
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
	const remoteRef = `refs/remotes/${remote}/${worktreeBranch}`;

	// Check if remote tracking branch exists. The old try/catch-only guard
	// never fired (pi.exec doesn't reject on non-zero exit) — a missing ref
	// was treated as "exists" and fetch/reset ran against a possibly
	// nonexistent worktree.
	const revParse = await execChecked(pi, "git", ["rev-parse", "--verify", remoteRef], {
		cwd,
		timeout: 10000,
	});
	if (revParse.code !== 0) {
		log.info(
			"worktree",
			`No remote tracking branch ${remote}/${worktreeBranch} — skipping reconciliation`,
		);
		return { ok: true, value: undefined };
	}

	log.info("worktree", `Remote tracking branch ${remote}/${worktreeBranch} exists — reconciling`);

	// Fetch latest from remote for this branch
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

	// Reset worktree to match remote tracking branch
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

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(
					pi,
					cwd,
					wt,
					worktreeBranch,
					"origin",
					notify,
				);
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
				const reconcile = await reconcileToRemoteBranch(
					pi,
					cwd,
					wt,
					worktreeBranch,
					"origin",
					notify,
				);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
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

			// Reconcile to remote tracking branch if one exists
			const reconcile = await reconcileToRemoteBranch(
				pi,
				cwd,
				wt,
				worktreeBranch,
				"origin",
				notify,
			);
			if (!reconcile.ok) {
				throw new Error(`Reconciliation failed: ${reconcile.error}`);
			}

			return wt;
		},
		notify,
		"worktree",
	);
}

// ponytail: copy git-ignored host dirs into worktree so extensions that depend
// on git-managed packages (ponytail hooks, etc.) can load, and the maintainer's
// host-side private-pi clone is available to agents. `.pi/git/` and `private-pi/`
// are in .gitignore — git worktree add doesn't copy them.
async function copyHostDirs(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<void> {
	const log = getDebugLogger();
	const dirs: Array<[string, string]> = [
		[resolvePath(cwd, ".pi/git"), resolvePath(worktreePath, ".pi/git")],
	];
	const privatePiSrc = resolvePath(cwd, "private-pi");
	if (existsSync(privatePiSrc)) {
		dirs.push([privatePiSrc, resolvePath(worktreePath, "private-pi")]);
	}
	for (const [src, dst] of dirs) {
		const cpRes = await execChecked(pi, "cp", ["-r", "--preserve=links", src, dst], {
			timeout: 30_000,
		});
		if (cpRes.code !== 0) {
			const msg = cpRes.stderr || cpRes.stdout || "cp failed";
			log.warn("worktree", `Failed to copy ${src}: ${msg} — continuing without`);
		} else {
			log.info("worktree", `Copied ${src} to ${dst}`);
		}
	}
}

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	await copyHostDirs(pi, cwd, worktreePath, notify);

	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Installing deps at ${worktreePath}`);

			// Attempt 1 — check result.code explicitly (pi.exec never rejects
			// on non-zero exit; the old try/catch logged "npm ci OK" even when
			// npm failed, e.g. package.json missing in a non-worktree dir).
			const first = await execChecked(pi, "npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
			if (first.code === 0) {
				log.info("worktree", "npm ci OK");
				return;
			}
			const firstMsg = (first.stderr || first.stdout || "npm ci failed").trim();
			log.warn("worktree", `npm ci failed (attempt 1): ${firstMsg}`);

			// Retry once for transient failures (e.g., network flake, registry timeout)
			const retry = await execChecked(pi, "npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
			if (retry.code === 0) {
				log.info("worktree", "npm ci OK on retry");
				return;
			}
			const retryMsg = (retry.stderr || retry.stdout || "npm ci failed").trim();
			log.warn("worktree", `npm ci failed (attempt 2): ${retryMsg}`);

			// Both attempts failed — throw to trigger Result failure
			throw new Error(
				`npm ci failed at ${worktreePath} after 2 attempts — continuing with potentially missing dependencies: ${retryMsg}`,
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
	const delRes = await execChecked(pi, "git", ["branch", "-D", worktreeBranch], {
		cwd,
		timeout: 10000,
	});
	if (delRes.code !== 0) {
		const msg = delRes.stderr || delRes.stdout || `git branch -D ${worktreeBranch} failed`;
		return { ok: false, error: msg, source: "worktree" };
	}
	return { ok: true, value: undefined };
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
			// Check result.code explicitly — pi.exec resolves {code} on non-zero
			// exit (never rejects), so failures surface instead of logging
			// "removed" unconditionally.
			const removeRes = await execChecked(
				pi,
				"git",
				["worktree", "remove", "--force", worktreePath],
				{
					cwd,
					timeout: 15000,
				},
			);
			if (removeRes.code !== 0) {
				throw new Error(removeRes.stderr || removeRes.stdout || "git worktree remove failed");
			}
			const pruneRes = await execChecked(pi, "git", ["worktree", "prune"], { cwd, timeout: 15000 });
			if (pruneRes.code !== 0) {
				throw new Error(pruneRes.stderr || pruneRes.stdout || "git worktree prune failed");
			}
			log.info("worktree", "Worktree removed");
			if (!skipBranch) {
				const branchRes = await execChecked(pi, "git", ["branch", "-D", worktreeBranch], {
					cwd,
					timeout: 10000,
				});
				if (branchRes.code !== 0) {
					throw new Error(
						branchRes.stderr || branchRes.stdout || `git branch -D ${worktreeBranch} failed`,
					);
				}
				log.info("worktree", `Branch ${worktreeBranch} deleted`);
			}
		},
		notify,
		"worktree",
	);
}
