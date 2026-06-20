// ─── Shared Utilities for Supervisor Checks ─────────────────────────
// Extracted common patterns from dead-code.ts, duplicate-code.ts,
// requirements-traceability.ts, package-safety.ts, and pipeline/helpers.ts.
//
// All check modules import from here instead of defining their own ExecFn
// or reimplementing git-diff / filter / sum logic.

// ─── Exec function type (local — not exported; each consumer declares its own)

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── Git diff helper ───────────────────────────────────────────────

/**
 * Get list of changed files from git diff against default branch (--name-only).
 *
 * Throws on failure — caller should wrap in try-catch to construct domain error shape.
 * Returns empty array if no changed files.
 */
export async function getChangedFilesFromGitDiff(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
): Promise<string[]> {
	const diffResult = await exec("git", ["diff", defaultBranch, "--name-only"], {
		cwd: worktreePath,
		timeout: 10_000,
	});
	if (diffResult.code !== 0) {
		throw new Error(`git diff failed: ${diffResult.stderr || "unknown error"}`);
	}
	return (diffResult.stdout || "")
		.trim()
		.split("\n")
		.map((f) => f.trim())
		.filter(Boolean);
}

// ─── Generic changed-file filter ───────────────────────────────────

/**
 * Generic filter that keeps only items associated with at least one changed file.
 *
 * @param items - Items to filter
 * @param changedFiles - List of changed file paths
 * @param getFiles - Function returning all file paths associated with an item
 * @returns Filtered items
 */
export function filterItemsToChangedFiles<T>(
	items: T[],
	changedFiles: string[],
	getFiles: (item: T) => string[],
): T[] {
	if (items.length === 0 || changedFiles.length === 0) return [];
	const changedSet = new Set(changedFiles);
	return items.filter((item) => getFiles(item).some((f) => changedSet.has(f)));
}

// ─── Generic line counter ──────────────────────────────────────────

/**
 * Generic line counter.
 *
 * @param items - Items to sum over
 * @param extractor - Function returning line count per item
 * @returns Total line count
 */
export function sumLines<T>(items: T[], extractor: (item: T) => number): number {
	return items.reduce((sum, item) => sum + extractor(item), 0);
}

// ─── ENOENT type guard ─────────────────────────────────────────────

/**
 * Type guard checking if an error is an ENOENT (executable not found) error.
 */
export function isExecutableNotFound(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}
