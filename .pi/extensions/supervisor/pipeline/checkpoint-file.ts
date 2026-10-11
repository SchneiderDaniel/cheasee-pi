// ─── Checkpoint File ──────────────────────────────────────────────
// Checkpoint file format, atomic write, staleness logic and the
// `supervisor-state*.json` scanners. Split out of state-checkpoint.ts
// (issue #2001); the public surface is re-exported from there.
//
// Atomic write pattern: write to temp → rename (same filesystem).
// Timestamp-only staleness (>1h maxAge): no PID check needed per
// research findings (PID recycling risk, platform complexity).
//
// State transitions: pre-tsc → pre-lsp → pre-auditor → completed
// On completion, the state file is deleted.

import {
	writeFileSync,
	readFileSync,
	renameSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import type { Result } from "./result.ts";

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

/**
 * Default max age for stale checkpoint detection: 1 hour.
 * If a checkpoint's startedAt is older than this (strictly >),
 * it's considered stale regardless of PID.
 */
const DEFAULT_MAX_AGE_MS = 3_600_000; // 1 hour

// ─── Internal Helpers ─────────────────────────────────────────────

function checkpointFilePath(cwd: string, issueNum: number): string {
	return resolve(cwd, ".pi", `supervisor-state-${issueNum}.json`);
}

function isCheckpointName(val: string): val is CheckpointName {
	return val === "pre-tsc" || val === "pre-lsp" || val === "pre-auditor";
}

/** All matching state files directly inside a `.pi` directory. */
export function stateFilesInPiDir(piDir: string): string[] {
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
export function findStateFiles(baseDir: string): string[] {
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
		// The file lives in an agent-writable `.pi/`, so every field is untrusted
		// input feeding a later `rm`. Reject anything that is not exactly the
		// shape the pipeline writes: the old `typeof === "string"` check let
		// `""`, relative and `/` paths through.
		if (
			!Number.isInteger(parsed.issueNum) ||
			(parsed.issueNum as number) <= 0 ||
			typeof parsed.checkpoint !== "string" ||
			!isCheckpointName(parsed.checkpoint) ||
			typeof parsed.worktreePath !== "string" ||
			!isAbsolute(parsed.worktreePath) ||
			typeof parsed.worktreeBranch !== "string" ||
			parsed.worktreeBranch === "" ||
			typeof parsed.startedAt !== "string"
		) {
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
