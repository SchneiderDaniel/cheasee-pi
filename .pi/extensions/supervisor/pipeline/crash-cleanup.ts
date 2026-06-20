// ─── Crash Cleanup: Signal Handler Registration ──────────────────
// Extracted for testability. Provides createCrashCleanup() which returns
// { register(), teardown() } for SIGTERM/SIGINT worktree cleanup.
// Also exports cleanupOnExit(…) for direct testing of the cleanup logic.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugLogger } from "../lib/debug.ts";
import type { NotifyFn } from "./helpers.ts";
import { cleanupWorktree, deleteBranch } from "./worktree.ts";
import type { Result } from "./result.ts";

// ─── Constants ────────────────────────────────────────────────────

/** Timeout for worktree cleanup on signal (10 seconds). */
export const CLEANUP_TIMEOUT_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────

export interface CleanupOnExitDeps {
	worktreePath: string | undefined;
	worktreeBranch: string | undefined;
	pi: ExtensionAPI;
	cwd: string;
	notify: NotifyFn;
	debugLogger: DebugLogger;
	exit?: (code: number) => void;
}

export interface CrashCleanup {
	/** Register SIGTERM/SIGINT handlers */
	register(): void;
	/** Remove SIGTERM/SIGINT handlers */
	teardown(): void;
}

// ─── Core Cleanup Logic ──────────────────────────────────────────

/**
 * Async cleanup that runs on SIGTERM/SIGINT.
 *
 * 1. Deletes branch via deleteBranch() BEFORE the timeout race
 *    (prevents orphaned branches if cleanup is interrupted).
 * 2. Calls cleanupWorktree (worktree remove –force, prune) with
 *    skipBranch=true inside a 10s Promise.race.
 *
 * On failure, logs via debugLogger and still calls exit(0).
 * If worktreePath or worktreeBranch is missing, skips cleanup.
 */
export async function cleanupOnExit(signal: string, deps: CleanupOnExitDeps): Promise<void> {
	if (deps.worktreePath && deps.worktreeBranch) {
		// Step 1: Delete branch BEFORE the race — near-instant ref operation.
		// This guarantees no orphaned branch even if the process is killed
		// mid-cleanup by the timeout or a second signal.
		const branchResult = await deleteBranch(deps.pi, deps.cwd, deps.worktreeBranch);
		if (!branchResult.ok) {
			deps.debugLogger.error("handler", `Signal ${signal} branch deletion failed`, {
				error: branchResult.error,
			});
		}

		// Step 2: Cleanup worktree (remove + prune) inside timeout race.
		// Branch was already deleted above, so skipBranch=true.
		try {
			const cleanup = cleanupWorktree(
				deps.pi,
				deps.cwd,
				deps.worktreePath,
				deps.worktreeBranch,
				deps.notify,
				true, // skipBranch — already deleted above
			);
			const timeout = new Promise<void>((_, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`Cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms`)),
					CLEANUP_TIMEOUT_MS,
				);
				timer.unref();
			});
			const raceResult = await Promise.race([cleanup, timeout]);
			// raceResult is Result<void> when cleanup wins the race.
			// When timeout wins, Promise.race rejects → handled in catch.
			const cleanupResult = raceResult as Result<void>;
			if (!cleanupResult.ok) {
				deps.debugLogger.error("handler", `Signal ${signal} cleanup failed`, {
					error: cleanupResult.error,
				});
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.debugLogger.error("handler", `Signal ${signal} cleanup failed`, { error: msg });
		}
	}
	(deps.exit ?? process.exit)(0);
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Creates a CrashCleanup instance with an isCleaningUp guard.
 * Prevents concurrent cleanup runs from multiple signals.
 */
export function createCrashCleanup(deps: CleanupOnExitDeps): CrashCleanup {
	let isCleaningUp = false;

	const handler = async (signal: string): Promise<void> => {
		if (isCleaningUp) {
			(deps.exit ?? process.exit)(1);
			return;
		}
		isCleaningUp = true;
		await cleanupOnExit(signal, deps);
	};

	return {
		register(): void {
			process.on("SIGTERM", handler);
			process.on("SIGINT", handler);
		},
		teardown(): void {
			process.removeListener("SIGTERM", handler);
			process.removeListener("SIGINT", handler);
		},
	};
}

/**
 * Convenience wrapper that creates a CrashCleanup and registers signal handlers.
 * Extracted for testability — Phase 3 verifies setup happens before pipeline loop
 * and teardown runs in finally block.
 */
export function setupCrashCleanup(deps: CleanupOnExitDeps): CrashCleanup {
	const cc = createCrashCleanup(deps);
	cc.register();
	return cc;
}

/**
 * Runs an async function with crash cleanup lifecycle.
 * Registers SIGTERM/SIGINT handlers before fn, tears down in finally.
 * Extracted for testability of the wiring pattern.
 */
export async function withCrashCleanup<T>(
	deps: CleanupOnExitDeps,
	fn: (cc: CrashCleanup) => Promise<T>,
): Promise<T> {
	const cc = setupCrashCleanup(deps);
	try {
		return await fn(cc);
	} finally {
		cc.teardown();
	}
}
