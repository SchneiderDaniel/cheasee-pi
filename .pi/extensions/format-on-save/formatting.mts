/**
 * formatting.mts — Shared utilities for format-on-save handler.
 *
 * Stripped down to essentials: path validation + file size guard.
 * Extension/lint detection is now delegated to adapter `canHandle()` methods.
 */

// ─── Config ───────────────────────────────────────────────────────────

/** Maximum file size for formatting (1MB) to avoid perf issues. */
export const MAX_FILE_SIZE_BYTES = 1_048_576;

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Check if a path looks like a valid file path (not a directory, not protocol).
 */
export function looksLikeFilePath(path: unknown): path is string {
	if (typeof path !== "string") return false;
	if (path.includes("://")) return false;
	if (path.startsWith("~")) return false;
	if (path.length === 0) return false;
	return true;
}
