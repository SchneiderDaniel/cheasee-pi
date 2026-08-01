// ─── Requirements Traceability — Git Diff Acquisition ─────────────
// Owns the step-1 `git diff --name-status` interaction and status-line
// parsing. Returns a discriminated DiffResult — error strings are raw
// (`stderr || "unknown error"`); the "git diff failed: " prefix
// formatting lives in the orchestrator (index.ts).

import type { ExecFn } from "../shared.ts";

/** A single parsed `git diff --name-status` entry. */
export interface DiffEntry {
	status: string;
	path: string;
	oldPath?: string;
}

/** Result of acquiring the git diff: parsed entries + changed paths, or failure. */
export type DiffResult =
	{ ok: true; diffEntries: DiffEntry[]; changedFiles: string[] } | { ok: false; error: string };

/**
 * Acquire and parse the git diff against the default branch.
 *
 * Non-zero exit codes and exec throws are folded into `{ ok: false }` —
 * the orchestrator decides whether to continue. On success, `changedFiles`
 * includes rename old-paths in addition to entry paths.
 *
 * @param exec - Exec function
 * @param worktreePath - Path to worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @returns DiffResult
 */
export async function getGitDiff(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
): Promise<DiffResult> {
	try {
		const diffResult = await exec("git", ["diff", defaultBranch, "--name-status"], {
			cwd: worktreePath,
			timeout: 10_000,
		});

		if (diffResult.code !== 0) {
			return { ok: false, error: diffResult.stderr || "unknown error" };
		}

		const diffEntries = parseDiffNameStatus(diffResult.stdout);
		const changedFiles = diffEntries.map((e) => e.path);

		// Also include old paths in changed files list for keyword search
		for (const entry of diffEntries) {
			if (entry.oldPath && !changedFiles.includes(entry.oldPath)) {
				changedFiles.push(entry.oldPath);
			}
		}

		return { ok: true, diffEntries, changedFiles };
	} catch (err: unknown) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Parse `git diff --name-status` output into structured entries.
 *
 * Each line has format: STATUS\tpath or STATUS\toldPath\tnewPath
 * Status letters: A (added), D (deleted), M (modified), R (renamed),
 * C (copied), etc.
 */
function parseDiffNameStatus(output: string): DiffEntry[] {
	if (!output || output.trim() === "") return [];

	const entries: DiffEntry[] = [];
	const lines = output.trim().split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Handle renames: R100\told\tnew
		const renameMatch = trimmed.match(/^(R\d+)\s+(.+?)\s+(.+)$/);
		if (renameMatch) {
			entries.push({
				status: renameMatch[1]!,
				path: renameMatch[3]!.trim(),
				oldPath: renameMatch[2]!.trim(),
			});
			continue;
		}

		// Handle simple: A/D/M\tpath
		const simpleMatch = trimmed.match(/^([ADM])\s+(.+)$/);
		if (simpleMatch) {
			entries.push({
				status: simpleMatch[1]!,
				path: simpleMatch[2]!.trim(),
			});
			continue;
		}
	}

	return entries;
}
