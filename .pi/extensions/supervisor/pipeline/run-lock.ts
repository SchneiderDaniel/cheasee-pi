// ─── Per-Issue Run Lock ───────────────────────────────────────────
// One pipeline per issue, enforced. Worktree paths are per-issue
// (`worktree-git-issue-<num>-<slug>`), so two runs of DIFFERENT issues
// never race on a worktree and run in parallel. Two runs of the SAME
// issue still race on the same worktree path (the second run's
// createWorktree silently reuses the live worktree, and whichever run
// finishes first removes it under the other's agent) — that race is what
// the per-issue lock guards. The lock is PID-backed: a crashed run leaves
// a dead PID behind, and the next run takes over instead of waiting out a
// timestamp.
//
// Split out of state-checkpoint.ts (issue #2001); the public surface is
// re-exported from there.

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import type { Result } from "./result.ts";

/** Matches per-issue run lock files: `supervisor-run-1503.json`. */
const RUN_LOCK_FILE_RE = /^supervisor-run-(\d+)\.json$/;

/** Bounded retries for the run-lock steal race (read → unlink → write). */
const MAX_ACQUIRE_ATTEMPTS = 3;

export interface RunLock {
	pid: number;
	issueNum: number;
	startedAt: string; // ISO 8601
}

export function runLockPath(cwd: string, issueNum: number): string {
	return resolve(cwd, ".pi", `supervisor-run-${issueNum}.json`);
}

/** True if a process with this PID exists (same container → same PID namespace). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// EPERM = exists but not ours (still alive); ESRCH = dead
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readRunLock(path: string): RunLock | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as RunLock).pid === "number" &&
			typeof (parsed as RunLock).issueNum === "number"
		) {
			return parsed as RunLock;
		}
	} catch {
		// Unreadable/corrupt lock — treat as stale
	}
	return null;
}

/**
 * Acquire the per-issue run lock. Fails (ok:false) when another pipeline
 * for the SAME issue is live; steals the lock when the holder's PID is
 * dead (crashed run). Atomic via `wx` (exclusive create).
 *
 * Steal-race loop: read → unlink → write is not atomic; if two runs steal
 * the same stale lock simultaneously, one wins the `wx` create and the
 * loser's write gets EEXIST. The loop re-checks the winner's liveness (a
 * fresh winner is live → clean "already running" error) and retries a
 * still-stale lock, bounded by MAX_ACQUIRE_ATTEMPTS.
 */
export function acquireRunLock(cwd: string, issueNum: number): Result<void> {
	const stateDir = resolve(cwd, ".pi");
	const path = runLockPath(cwd, issueNum);
	const ownLock: RunLock = {
		pid: process.pid,
		issueNum,
		startedAt: new Date().toISOString(),
	};
	try {
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}
		for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
			try {
				writeFileSync(path, JSON.stringify(ownLock), { flag: "wx" });
				return { ok: true, value: undefined };
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
					throw err;
				}
			}
			// Lock exists — live holder blocks, dead holder gets taken over
			const existing = readRunLock(path);
			if (existing && pidAlive(existing.pid)) {
				return {
					ok: false,
					error:
						`Another supervisor pipeline is already running (pid ${existing.pid}, issue #${existing.issueNum}, started ${existing.startedAt}). ` +
						"One pipeline at a time per repo — wait for it to finish or stop it first.",
					source: "run-lock",
				};
			}
			// Stale lock (crashed holder) — steal it and retry the write.
			try {
				unlinkSync(path);
			} catch {
				// Another acquirer stole it between read and unlink — loop
				// retries and re-checks the winner's liveness.
			}
		}
		// Persistent EEXIST (unstealable path) — give up after bounded retries.
		return {
			ok: false,
			error: `Failed to acquire run lock: EEXIST after ${MAX_ACQUIRE_ATTEMPTS} attempts`,
			source: "run-lock",
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("run-lock", `Failed to acquire run lock: ${msg}`);
		return { ok: false, error: `Failed to acquire run lock: ${msg}`, source: "run-lock" };
	}
}

/** Release the run lock for an issue — only if we own it (PID match). Idempotent, best-effort. */
export function releaseRunLock(cwd: string, issueNum: number): void {
	try {
		const lock = readRunLock(runLockPath(cwd, issueNum));
		if (lock && lock.pid === process.pid) {
			unlinkSync(runLockPath(cwd, issueNum));
		}
	} catch {
		// Best-effort — nothing to do
	}
}

/**
 * True when any OTHER issue's run lock is held by a live process.
 * Used to decide whether a completing pipeline may clear the shared
 * footer: with two same-host pipelines, the first finisher must not
 * clear the second run's footer data.
 *
 * Corrupt/unreadable lock files are treated as not live.
 */
export function isAnyOtherPipelineLive(cwd: string, excludeIssueNum: number): boolean {
	try {
		const stateDir = resolve(cwd, ".pi");
		if (!existsSync(stateDir)) {
			return false;
		}
		for (const entry of readdirSync(stateDir)) {
			const m = RUN_LOCK_FILE_RE.exec(entry);
			if (!m || Number(m[1]) === excludeIssueNum) {
				continue;
			}
			const lock = readRunLock(join(stateDir, entry));
			if (lock && pidAlive(lock.pid)) {
				return true;
			}
		}
	} catch {
		// Unreadable dir — treat as no live pipeline
	}
	return false;
}
