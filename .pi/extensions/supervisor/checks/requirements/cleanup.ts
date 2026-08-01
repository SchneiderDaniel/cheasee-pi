// ─── Requirements Traceability — Old Reference Cleanup ────────────
// Checks that deleted/renamed files have no remaining references in
// the codebase via `git grep`. Returns gaps; git grep failures are
// non-fatal and swallowed here.

import { basename } from "node:path";

import type { ExecFn } from "../shared.ts";
import type { TraceabilityGap } from "./types.ts";
import type { DiffEntry } from "./diff.ts";

/**
 * Check that deleted/renamed files have no remaining references in the codebase.
 *
 * For each deleted file or renamed old-path, runs `git grep` on the remaining
 * codebase (at HEAD) for the old module name, import path, or function name.
 *
 * @param exec - Exec function
 * @param worktreePath - Path to worktree
 * @param diffEntries - Parsed diff entries
 * @returns Array of gaps (one per old reference found)
 */
export async function checkOldReferenceCleanup(
	exec: ExecFn,
	worktreePath: string,
	diffEntries: DiffEntry[],
): Promise<TraceabilityGap[]> {
	if (diffEntries.length === 0) return [];

	// Collect old paths from deletions and renames
	const oldPaths: string[] = [];

	for (const entry of diffEntries) {
		if (entry.status === "D") {
			oldPaths.push(entry.path);
		}
		if (entry.status.startsWith("R") && entry.oldPath) {
			oldPaths.push(entry.oldPath);
		}
	}

	if (oldPaths.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const oldPath of oldPaths) {
		// Extract the base name (without extension) for import reference checking
		const baseName = basename(oldPath);
		const nameWithoutExt = baseName.replace(/\.[^.]+$/, "");

		// Also extract module-like references: path segments, camelCase names
		const refPatterns = [nameWithoutExt, oldPath.replace(/^src\//, "")];

		for (const pattern of refPatterns) {
			try {
				const result = await exec("git", ["grep", "-l", pattern], {
					cwd: worktreePath,
					timeout: 10_000,
				});
				if (result.code === 0 && result.stdout.trim()) {
					const filesWithRefs = result.stdout.trim().split("\n").filter(Boolean);
					gaps.push({
						check: "old-reference-cleanup",
						severity: "warning",
						detail: `Deleted/renamed file "${oldPath}" still referenced in ${filesWithRefs.length} file(s): ${filesWithRefs.slice(0, 5).join(", ")}${filesWithRefs.length > 5 ? `... and ${filesWithRefs.length - 5} more` : ""}`,
					});
					break; // Only report once per old path
				}
			} catch {
				// grep failure is non-fatal
			}
		}
	}

	return gaps;
}
