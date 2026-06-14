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
				return wt;
			} catch (err2: unknown) {
				const attempt2Err = err2 instanceof Error ? err2.message : String(err2);
				log.warn("worktree", `Attempt 2 failed: ${attempt2Err}`);
			}

			// Both attempts failed — check if worktree dir somehow exists
			try {
				await pi.exec("test", ["-d", wt], { timeout: 5000 });
				log.warn("worktree", "Both attempts failed but worktree dir exists — using it");
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

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(
	pi: ExtensionAPI,
	worktreePath: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Installing deps at ${worktreePath}`);

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

// ─── Cleanup Worktree ────────────────────────────────────────────

export async function cleanupWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	worktreeBranch: string,
	notify: NotifyFn,
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
			await pi.exec("git", ["branch", "-D", worktreeBranch], { cwd, timeout: 10000 });
			log.info("worktree", `Branch ${worktreeBranch} deleted`);
		},
		notify,
		"worktree",
	);
}
