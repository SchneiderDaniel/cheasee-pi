// ─── Requirements Traceability — Checklist Keyword Coverage ───────
// Checks that keywords from checklist items appear in changed files
// via `grep`. Returns gaps; throws only on unexpected errors (grep
// failures are non-fatal and swallowed here).

import type { ExecFn } from "../shared.ts";
import type { TraceabilityGap, ChecklistKeywords } from "./types.ts";

/**
 * Check if keywords from checklist items appear in changed files.
 *
 * Uses the ExecFn to run `grep` for each keyword in each changed file.
 * A match is found if at least one keyword from a checklist item appears
 * in at least one changed file.
 *
 * @param exec - Exec function
 * @param worktreePath - Path to worktree
 * @param changedFiles - List of changed file paths
 * @param checklistKeywords - Keywords per checklist item
 * @returns Array of gaps (one per unmatched item)
 */
export async function checkChecklistKeywordCoverage(
	exec: ExecFn,
	worktreePath: string,
	changedFiles: string[],
	checklistKeywords: ChecklistKeywords[],
): Promise<TraceabilityGap[]> {
	if (checklistKeywords.length === 0 || changedFiles.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const entry of checklistKeywords) {
		if (entry.keywords.length === 0) continue;

		let found = false;

		// Check each keyword against each changed file via grep
		for (const keyword of entry.keywords) {
			for (const file of changedFiles) {
				try {
					const result = await exec("grep", ["-l", keyword, file], {
						cwd: worktreePath,
						timeout: 5_000,
					});
					if (result.code === 0) {
						found = true;
						break;
					}
				} catch {
					// grep failure is non-fatal
				}
			}
			if (found) break;
		}

		if (!found) {
			gaps.push({
				check: "checklist-keyword-coverage",
				severity: "warning",
				detail: `Checklist item "${entry.item}" — no keywords matched in changed files. Keywords checked: ${entry.keywords.join(", ")}`,
			});
		}
	}

	return gaps;
}
