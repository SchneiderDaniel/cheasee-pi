// ─── Worktree lifecycle: dependencies, branch + cleanup ───────────
// Split out of worktree.ts (issue #2005 Long File refactor). Host-dir
// copying, venv linking, dependency install, branch deletion and worktree
// removal. worktree.ts re-exports these names so existing importers keep
// working.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { execChecked, withNotify, type Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";

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

	await linkWorktreeVenvs(cwd, worktreePath);
}

/**
 * Link the main repo's prebuilt web_search/web_crawl venvs into a worktree.
 *
 * Worktrees start without `.pi/scrapling-venv` / `.pi/web-search-venv`, so the
 * first web_crawl call in a subagent triggered a FULL fresh build: pip install
 * of scrapling[fetchers] over the flaky container network died mid-download,
 * and ensureVenv's in-memory retry cache then rejected every later call with
 * "Venv setup previously failed after N attempts" (0.0s instant failures).
 *
 * Symlink (not copy): venvs are hundreds of MB and the prebuilt copies already
 * exist in main's `.pi`. ensureVenv's `rm -rf` on a symlink removes only the
 * link, so a broken venv still rebuilds in place at the worktree.
 */
export async function linkWorktreeVenvs(cwd: string, worktreePath: string): Promise<void> {
	const log = getDebugLogger();
	const venvLinks: Array<[string, string]> = [
		[resolvePath(cwd, ".pi/scrapling-venv"), resolvePath(worktreePath, ".pi/scrapling-venv")],
		[resolvePath(cwd, ".pi/web-search-venv"), resolvePath(worktreePath, ".pi/web-search-venv")],
	];
	for (const [src, dst] of venvLinks) {
		if (!existsSync(src)) {
			continue; // no prebuilt venv (bare dev machine) — ensureVenv builds fresh
		}
		mkdirSync(dirname(dst), { recursive: true });
		try {
			rmSync(dst, { force: true, recursive: true }); // stale dir/link from a previous run
			symlinkSync(relative(dirname(dst), src), dst, "dir");
			log.info("worktree", `Linked ${src} -> ${dst}`);
		} catch (err) {
			log.warn(
				"worktree",
				`Failed to link venv ${src}: ${(err as Error).message} — continuing without`,
			);
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
			// Double --force: git refuses to remove a locked worktree with a
			// single --force (entrypoint.sh locks every worktree registration).
			// The lock only protects against prune; we own this worktree.
			const removeRes = await execChecked(
				pi,
				"git",
				["worktree", "remove", "--force", "--force", worktreePath],
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
