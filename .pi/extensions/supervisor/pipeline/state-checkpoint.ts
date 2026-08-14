// ─── Pipeline State Checkpoint ────────────────────────────────────
// Lightweight state checkpoint file for crash recovery.
// Written before heavy/long-running operations so the supervisor can
// detect stale worktrees on restart.
//
// Atomic write pattern: write to temp → rename (same filesystem).
// Timestamp-only staleness (>1h maxAge): no PID check needed per
// research findings (PID recycling risk, platform complexity).
//
// State transitions: pre-tsc → pre-lsp → pre-auditor → completed
// On completion, the state file is deleted.
//
// Both the run lock and the checkpoint are keyed per issue:
//   .pi/supervisor-run-<issueNum>.json
//   .pi/supervisor-state-<issueNum>.json
// Two pipelines on DIFFERENT issues run in parallel (worktree paths are
// per-issue); two pipelines on the SAME issue still serialize on the
// per-issue lock. The scanner also matches the legacy bare-name
// `supervisor-state.json` so a mid-upgrade orphan is still cleaned up.
//
// Boundaries:
//   - state-checkpoint.ts — file format, write atomicity, staleness logic
//   - handler.ts — startup cleanup, auditor checkpoint, completion delete
//   - audit.ts — pre-TSC and pre-LSP checkpoints

import {
	writeFileSync,
	readFileSync,
	renameSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import type { Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../config/types.ts";
import { resolveWorktreeBase } from "./worktree.ts";

// ─── Types ─────────────────────────────────────────────────────────

export type CheckpointName = "pre-tsc" | "pre-lsp" | "pre-auditor";

export interface SupervisorCheckpointState {
	issueNum: number;
	checkpoint: CheckpointName;
	worktreePath: string;
	worktreeBranch: string;
	startedAt: string; // ISO 8601
}

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Matches per-issue checkpoint names (`supervisor-state-1503.json`) plus
 * the legacy bare-name file (`supervisor-state.json`) left behind by the
 * pre-per-issue build. The `.tmp` suffix never matches.
 */
const STATE_FILE_RE = /^supervisor-state(?:-\d+)?\.json$/;

/** Matches per-issue run lock files: `supervisor-run-1503.json`. */
const RUN_LOCK_FILE_RE = /^supervisor-run-(\d+)\.json$/;

/**
 * Default max age for stale checkpoint detection: 1 hour.
 * If a checkpoint's startedAt is older than this (strictly >),
 * it's considered stale regardless of PID.
 */
const DEFAULT_MAX_AGE_MS = 3_600_000; // 1 hour

/** Bounded retries for the run-lock steal race (read → unlink → write). */
const MAX_ACQUIRE_ATTEMPTS = 3;

// ─── Internal Helpers ─────────────────────────────────────────────

function checkpointFilePath(cwd: string, issueNum: number): string {
	return resolve(cwd, ".pi", `supervisor-state-${issueNum}.json`);
}

function isCheckpointName(val: string): val is CheckpointName {
	return val === "pre-tsc" || val === "pre-lsp" || val === "pre-auditor";
}

/** All matching state files directly inside a `.pi` directory. */
function stateFilesInPiDir(piDir: string): string[] {
	const results: string[] = [];
	try {
		if (!existsSync(piDir)) {
			return results;
		}
		for (const f of readdirSync(piDir)) {
			if (STATE_FILE_RE.test(f)) {
				results.push(join(piDir, f));
			}
		}
	} catch {
		// Unreadable — no files found
	}
	return results;
}

/**
 * Recursively find all `supervisor-state*.json` files under a directory.
 * Scans direct child directories only (1 level deep) — worktree dirs are
 * flat under worktreeBase.
 */
function findStateFiles(baseDir: string): string[] {
	const results: string[] = [];
	try {
		const entries = readdirSync(baseDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				// Worktree subdir: <wt>/.pi/supervisor-state*.json
				results.push(...stateFilesInPiDir(join(baseDir, entry.name, ".pi")));
			}
		}
		// Also baseDir/.pi directly
		results.push(...stateFilesInPiDir(join(baseDir, ".pi")));
	} catch {
		// Directory doesn't exist or can't be read — no files found
	}
	return [...new Set(results)];
}

// ─── Pure Functions ───────────────────────────────────────────────

/**
 * Returns true if the checkpoint's `startedAt` is strictly older than `maxAgeMs`.
 * Pure function — no side effects, no I/O.
 *
 * @param state - Checkpoint state to evaluate
 * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
export function isStaleCheckpoint(
	state: SupervisorCheckpointState,
	maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
	const startedAt = new Date(state.startedAt).getTime();
	if (isNaN(startedAt)) {
		// Invalid date in startedAt — treat as stale (safety: clean up)
		return true;
	}
	return Date.now() - startedAt > maxAgeMs;
}

// ─── File I/O Functions ───────────────────────────────────────────

/**
 * Private helper: read, parse, and validate a checkpoint state file at the given path.
 *
 * Returns `null` if:
 * - The file doesn't exist
 * - The file can't be parsed as JSON
 * - The JSON has missing or invalid required fields
 */
function readCheckpointFileAtPath(filePath: string): SupervisorCheckpointState | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof parsed.issueNum !== "number" ||
			typeof parsed.checkpoint !== "string" ||
			typeof parsed.worktreePath !== "string" ||
			typeof parsed.worktreeBranch !== "string" ||
			typeof parsed.startedAt !== "string"
		) {
			return null;
		}
		if (!isCheckpointName(parsed.checkpoint as string)) {
			return null;
		}
		return parsed as unknown as SupervisorCheckpointState;
	} catch {
		return null;
	}
}

/**
 * Read and parse a checkpoint state file from a specific path.
 * Used by cleanupStalePipelineState for state files found under worktree dirs.
 *
 * Returns `null` on any parse error or missing/invalid fields.
 */
export function readCheckpointFileFromPath(filePath: string): SupervisorCheckpointState | null {
	return readCheckpointFileAtPath(filePath);
}

/**
 * Write checkpoint state atomically to `.pi/supervisor-state-<issueNum>.json`.
 * The file name derives from `state.issueNum`, so parallel pipelines on
 * different issues never clobber each other's checkpoint.
 *
 * Atomic pattern: write to temp file → rename (atomic on same filesystem).
 * This prevents truncated JSON on crash mid-write.
 *
 * Creates `.pi/` directory if it doesn't exist.
 *
 * @returns `Result<void>` — ok=true on success, ok=false on failure
 */
export function writeCheckpointFile(cwd: string, state: SupervisorCheckpointState): Result<void> {
	const stateDir = resolve(cwd, ".pi");
	const targetPath = checkpointFilePath(cwd, state.issueNum);
	const tmpPath = resolve(stateDir, `supervisor-state-${state.issueNum}.json.tmp`);

	try {
		// Ensure .pi directory exists
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}

		// Write to temp file
		const json = JSON.stringify(state, null, 2);
		writeFileSync(tmpPath, json, "utf-8");

		// Rename temp → target (atomic on same filesystem)
		renameSync(tmpPath, targetPath);

		getDebugLogger().info("state-checkpoint", `Checkpoint written: ${state.checkpoint}`, {
			issueNum: state.issueNum,
			checkpoint: state.checkpoint,
			worktreeBranch: state.worktreeBranch,
		});

		return { ok: true, value: undefined };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("state-checkpoint", `Failed to write checkpoint: ${msg}`);
		// Clean up temp file if it exists
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath);
			}
		} catch {
			// Best-effort cleanup of temp file
		}
		return { ok: false, error: msg, source: "state-checkpoint" };
	}
}

/**
 * Delete the checkpoint state file at `.pi/supervisor-state-<issueNum>.json`.
 * Idempotent — returns ok even if the file doesn't exist.
 */
export function deleteCheckpointFile(cwd: string, issueNum: number): Result<void> {
	const filePath = checkpointFilePath(cwd, issueNum);
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
			getDebugLogger().info("state-checkpoint", "Checkpoint file deleted", { issueNum });
		}
		return { ok: true, value: undefined };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("state-checkpoint", `Failed to delete checkpoint: ${msg}`);
		return { ok: false, error: msg, source: "state-checkpoint" };
	}
}

// ─── Run Lock ────────────────────────────────────────────────────
// One pipeline per issue, enforced. Worktree paths are per-issue
// (`worktree-git-issue-<num>-<slug>`), so two runs of DIFFERENT issues
// never race on a worktree and run in parallel. Two runs of the SAME
// issue still race on the same worktree path (the second run's
// createWorktree silently reuses the live worktree, and whichever run
// finishes first removes it under the other's agent) — that race is what
// the per-issue lock guards. The lock is PID-backed: a crashed run leaves
// a dead PID behind, and the next run takes over instead of waiting out a
// timestamp.

interface RunLock {
	pid: number;
	issueNum: number;
	startedAt: string; // ISO 8601
}

function runLockPath(cwd: string, issueNum: number): string {
	return resolve(cwd, ".pi", `supervisor-run-${issueNum}.json`);
}

/** True if a process with this PID exists (same container → same PID namespace). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// EPERM = exists but not ours (still alive); ESRCH = dead
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRunLock(path: string): RunLock | null {
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

// ─── Cleanup Function ─────────────────────────────────────────────

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
 * - Liveness guard: never cleans a checkpoint whose per-issue run lock is held
 *   by a live process — with per-issue parallelism, run B's preflight must not
 *   prune run A's live worktree just because A's last checkpoint is >1h old.
 *   The lock lives in the main repo `.pi/`, so it survives partial worktree
 *   removal (the `recoverStaleWorktreeRegistration` scenario stays covered).
 *   A dead-PID lock does not protect — the crash case still cleans.
 * - Non-blocking: if cleanup of one stale checkpoint fails, logs warning and continues to the next.
 * - Runs `git worktree prune` before `git worktree remove --force` so git admin data is synced.
 * - Includes `rm -rf` fallback for the worktree directory after git operations succeed.
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
		log.info(
			"state-checkpoint",
			"No supervisor-state*.json files found — no stale state to clean",
		);
		return { ok: true, value: undefined };
	}

	let anyError = false;
	const warnings: string[] = [];

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

		// Liveness guard: a live pipeline owns this issue's worktree. Never
		// prune it — even a >1h-old checkpoint must not let run B remove run
		// A's live worktree. Dead-PID locks (crashed runs) still get cleaned.
		const issueLock = readRunLock(runLockPath(cwd, state.issueNum));
		if (issueLock && pidAlive(issueLock.pid)) {
			log.info("state-checkpoint", "Skipping cleanup — issue has a live pipeline", {
				issueNum: state.issueNum,
				pid: issueLock.pid,
			});
			continue;
		}

		// ── Stale checkpoint — clean up worktree ──
		notify.info(
			`Cleaning up stale worktree from issue #${state.issueNum} at ${state.worktreePath}`,
		);
		log.info("state-checkpoint", "Cleaning up stale worktree", {
			issueNum: state.issueNum,
			worktreePath: state.worktreePath,
			branch: state.worktreeBranch,
			checkpoint: state.checkpoint,
		});

		// Step 1: git worktree prune — sync admin state first
		try {
			await pi.exec("git", ["worktree", "prune"], { cwd, timeout: 15000 });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `git worktree prune failed: ${msg}`);
			warnings.push(`prune failed: ${msg}`);
		}

		// Step 2: git worktree remove --force --force (double force overrides
		// the entrypoint.sh lock — single --force refuses locked worktrees)
		try {
			await pi.exec("git", ["worktree", "remove", "--force", "--force", state.worktreePath], {
				cwd,
				timeout: 15000,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `git worktree remove --force --force failed: ${msg}`);
			warnings.push(`remove failed: ${msg}`);
		}

		// Step 3: git branch -D
		try {
			await pi.exec("git", ["branch", "-D", state.worktreeBranch], { cwd, timeout: 10000 });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `git branch -D failed: ${msg}`);
			warnings.push(`branch delete failed: ${msg}`);
		}

		// Step 4: rm -rf fallback for worktree directory
		try {
			// Use rm -rf via pi.exec
			await pi.exec("rm", ["-rf", state.worktreePath], { timeout: 30000 });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `rm -rf worktree dir failed: ${msg}`);
			warnings.push(`rm fallback failed: ${msg}`);
		}

		// Step 5: Delete the state file itself
		try {
			if (existsSync(stateFile)) {
				unlinkSync(stateFile);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("state-checkpoint", `Failed to delete stale state file: ${msg}`);
			warnings.push(`state file delete failed: ${msg}`);
		}

		notify.info(`Cleaned up stale worktree from issue #${state.issueNum}`);
		log.info("state-checkpoint", "Stale worktree cleanup complete", {
			issueNum: state.issueNum,
			worktreePath: state.worktreePath,
		});
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
