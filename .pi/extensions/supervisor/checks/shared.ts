// ─── Shared Utilities for Supervisor Checks ─────────────────────────
// Git-diff parsing and ENOENT error classification for supervisor checks.
//
// Originally included filter / sum wrappers now inlined at their call sites
// (dead-code.ts, duplicate-code.ts) — those were 1-line stdlib calls whose
// indirection added no clarity. Only functions with non-trivial domain logic
// (git parsing, ENOENT detection) remain.

// ─── Exec function type

/** Exec function type for subprocess calls (3-field return — code, stdout, stderr) */
export type ExecFn = (
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

// ─── ENOENT type guard ─────────────────────────────────────────────

/**
 * Type guard checking if an error is an ENOENT (executable not found) error.
 */
export function isExecutableNotFound(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}
