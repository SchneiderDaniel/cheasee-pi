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

const STATE_FILE_NAME = "supervisor-state.json";

/**
 * Default max age for stale checkpoint detection: 1 hour.
 * If a checkpoint's startedAt is older than this (strictly >),
 * it's considered stale regardless of PID.
 */
const DEFAULT_MAX_AGE_MS = 3_600_000; // 1 hour

// ─── Internal Helpers ─────────────────────────────────────────────

function stateFilePath(cwd: string): string {
	return resolve(cwd, ".pi", STATE_FILE_NAME);
}

function isCheckpointName(val: string): val is CheckpointName {
	return val === "pre-tsc" || val === "pre-lsp" || val === "pre-auditor";
}

/**
 * Recursively find all `supervisor-state.json` files under a directory.
 * Scans direct child directories only (1 level deep) — worktree dirs are
 * flat under worktreeBase.
 */
function findStateFiles(baseDir: string): string[] {
	const results: string[] = [];
	try {
		const entries = readdirSync(baseDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const statePath = join(baseDir, entry.name, ".pi", STATE_FILE_NAME);
				if (existsSync(statePath)) {
					results.push(statePath);
				}
			}
			// Also check directly in baseDir (state file could be in baseDir/.pi/)
			if (entry.name === ".pi" && entry.isDirectory()) {
				const statePath = join(baseDir, ".pi", STATE_FILE_NAME);
				if (existsSync(statePath)) {
					results.push(statePath);
				}
			}
		}
		// Also check baseDir/.pi/supervisor-state.json directly
		const directStatePath = join(baseDir, ".pi", STATE_FILE_NAME);
		if (existsSync(directStatePath)) {
			results.push(directStatePath);
		}
	} catch {
		// Directory doesn't exist or can't be read — no files found
	}
	return results;
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
 * Write checkpoint state atomically to `.pi/supervisor-state.json`.
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
	const targetPath = resolve(stateDir, STATE_FILE_NAME);
	const tmpPath = resolve(stateDir, `${STATE_FILE_NAME}.tmp`);

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
 * Delete the checkpoint state file at `.pi/supervisor-state.json`.
 * Idempotent — returns ok even if the file doesn't exist.
 */
export function deleteCheckpointFile(cwd: string): Result<void> {
	const filePath = stateFilePath(cwd);
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
			getDebugLogger().info("state-checkpoint", "Checkpoint file deleted");
		}
		return { ok: true, value: undefined };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("state-checkpoint", `Failed to delete checkpoint: ${msg}`);
		return { ok: false, error: msg, source: "state-checkpoint" };
	}
}

// ─── Cleanup Function ─────────────────────────────────────────────

/**
 * Scan for stale supervisor state checkpoint files and clean up their worktrees.
 *
 * Searches in two locations:
 * 1. The main repo's `.pi/supervisor-state.json`
 * 2. All worktree subdirectories under `worktreeBase` that contain `.pi/supervisor-state.json`
 *
 * For each stale checkpoint (age > maxAgeMs), removes the worktree and branch.
 * - Wraps each git command in try-catch so failure of one doesn't block others.
 * - Skips self-cleanup: never cleans a checkpoint whose `worktreePath` matches `currentWorktreePath`.
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

	// Collect all supervisor-state.json files to check
	const stateFiles: string[] = [];

	// 1. Check main repo's .pi/supervisor-state.json
	const mainStatePath = stateFilePath(cwd);
	if (existsSync(mainStatePath)) {
		stateFiles.push(mainStatePath);
	}

	// 2. Scan worktree directories for state files
	if (existsSync(baseDir)) {
		const found = findStateFiles(baseDir);
		// Deduplicate — mainStatePath already added
		for (const f of found) {
			if (!stateFiles.includes(f)) {
				stateFiles.push(f);
			}
		}
	}

	if (stateFiles.length === 0) {
		log.info("state-checkpoint", "No supervisor-state.json files found — no stale state to clean");
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
