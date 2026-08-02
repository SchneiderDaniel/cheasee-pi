// ─── Requirements Traceability — Orchestrator ─────────────────────
// Runs the 4 deterministic traceability checks in a fixed order and
// assembles the gap list. Owns per-step try/catch, gap push order, and
// all error-string wording; the check modules return data or throw and
// never push into a shared gaps array. Gap order is call order, so
// serialized output stays byte-identical (ECMA-262 insertion order).

import type { ExecFn } from "../shared.ts";

import { getGitDiff } from "./diff.ts";
import { parseIssueBodyChecklists, extractChecklistKeywords } from "./parse.ts";
import { checkChecklistKeywordCoverage } from "./coverage.ts";
import { checkTestFileParity } from "./parity.ts";
import { checkOldReferenceCleanup } from "./cleanup.ts";
import { extractTitleVerb, checkTitleDiffDirection } from "./title.ts";
import type { TraceabilityGap, FilteredIssueData } from "./types.ts";

// Re-exports — the historical public surface of requirements-traceability.ts.
export { isTestableFile } from "../file-classification.ts";
export { parseIssueBodyChecklists, extractChecklistKeywords } from "./parse.ts";
export { extractTitleVerb, classifyDiffDirection } from "./title.ts";
export type { TraceabilityGap, FilteredIssueData } from "./types.ts";

/** Verbatim "… check failed: " prefixes, keyed by check id. */
const CHECK_DETAIL_PREFIX: Record<string, string> = {
	"checklist-keyword-coverage": "Checklist keyword check",
	"test-file-parity": "Test file parity check",
	"old-reference-cleanup": "Old reference cleanup check",
	"title-diff-direction": "Title-diff direction check",
};

/** Run one check inside its try/catch; failures push a warning gap and continue. */
async function runStep(
	gaps: TraceabilityGap[],
	check: string,
	run: () => TraceabilityGap[] | Promise<TraceabilityGap[]>,
): Promise<void> {
	try {
		gaps.push(...(await run()));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check,
			severity: "warning",
			detail: `${CHECK_DETAIL_PREFIX[check]} failed: ${msg}`,
		});
	}
}

/**
 * Run all requirements-traceability checks.
 *
 * Orchestrates 4 deterministic checks:
 * 1. Checklist keyword → diff coverage
 * 2. Test file parity
 * 3. Old reference cleanup
 * 4. Issue title → diff direction
 *
 * All checks are non-blocking. Results are surfaced to the auditor agent
 * as a structured gap list. The auditor decides severity.
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @param filteredData - Filtered issue data (body + comments)
 * @param issueTitle - Issue title
 * @returns Array of traceability gaps
 */
export async function runRequirementsTraceability(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
	filteredData: FilteredIssueData,
	issueTitle: string,
): Promise<TraceabilityGap[]> {
	const gaps: TraceabilityGap[] = [];

	// Step 1: git diff — failure is fatal to this gate (single warning gap, early return)
	const diffResult = await getGitDiff(exec, worktreePath, defaultBranch);
	if (!diffResult.ok) {
		gaps.push({
			check: "diff",
			severity: "warning",
			detail: `git diff failed: ${diffResult.error}`,
		});
		return gaps;
	}

	const body = filteredData?.body || "";
	const title = issueTitle || "";

	// Steps 2-5: per-check try/catch; failures push a warning gap and continue
	await runStep(gaps, "checklist-keyword-coverage", async () => {
		return checkChecklistKeywordCoverage(
			exec,
			worktreePath,
			diffResult.changedFiles,
			extractChecklistKeywords(parseIssueBodyChecklists(body)),
		);
	});
	await runStep(gaps, "test-file-parity", () =>
		checkTestFileParity(diffResult.changedFiles, worktreePath),
	);
	await runStep(gaps, "old-reference-cleanup", () =>
		checkOldReferenceCleanup(exec, worktreePath, diffResult.diffEntries),
	);
	await runStep(gaps, "title-diff-direction", () =>
		checkTitleDiffDirection(extractTitleVerb(title), title, diffResult.diffEntries),
	);

	return gaps;
}
