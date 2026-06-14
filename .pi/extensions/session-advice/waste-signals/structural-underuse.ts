/**
 * structural-underuse.ts — D8: Code file reads/edits without structural_search
 *
 * Flags when 3+ code files are touched (read/edit/write) but structural_search
 * was never called. Suggests the agent could have used an AST query instead.
 *
 * Co-locates CODE_FILE_EXTS, CODE_TOUCH_TOOLS, and code file helpers
 * (single-consumer helpers).
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { getEntryPath, sumTokenCost, sumDollarCost } from "../token-utils.ts";

/** Code file extensions that trigger structural-search-underuse detection. */
const CODE_FILE_EXTS = new Set([
	".ts",
	".js",
	".py",
	".tsx",
	".jsx",
	".mts",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".swift",
	".kt",
]);

/** True if the file path ends with a known code file extension. */
function isCodeFilePath(filePath: string): boolean {
	const extIdx = filePath.lastIndexOf(".");
	if (extIdx < 0) return false;
	const ext = filePath.slice(extIdx).toLowerCase();
	return CODE_FILE_EXTS.has(ext);
}

/** Entry tool names that indicate a code file touch. */
const CODE_TOUCH_TOOLS = new Set(["read", "edit", "write", "writeIfEmpty", "editExisting"]);

/** Check if a session entry is a code file touch (read/edit/write on a code file). */
function isCodeFileTouch(e: SessionEntry): boolean {
	if (!CODE_TOUCH_TOOLS.has(e.toolName ?? "")) return false;
	const p = getEntryPath(e);
	return p.length > 0 && isCodeFilePath(p);
}

/** Check if a session entry has a given tool name. */
function hasToolName(e: SessionEntry, name: string): boolean {
	return e.toolName === name;
}

/**
 * Detect when the agent touches multiple code files without using structural_search.
 */
export function detectStructuralSearchUnderuse(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];

	// Check if any structural_search call exists
	const hasStructuralSearch = data.entries.some((e) => hasToolName(e, "structural_search"));
	if (hasStructuralSearch) return results;

	// Collect code file touches
	const codeTouches = data.entries.filter(isCodeFileTouch);
	if (codeTouches.length < 3) return results;

	// Check if all code touches are on the same file path (redundant-read territory, not ours)
	const uniquePaths = new Set(codeTouches.map((e) => getEntryPath(e)));
	if (uniquePaths.size === 1) return results;

	// Calculate waste: sumTokenCost of offending calls minus structural_search overhead
	const waste = sumTokenCost(codeTouches);
	// Estimate 1 structural_search call would have been sufficient
	const estimatedSearchCost = 50;
	const actualWaste = Math.max(0, waste - estimatedSearchCost);

	const details = codeTouches.map(
		(e) => `${e.toolName} ${getEntryPath(e)} (turn ${e.turnIndex}) instead of structural_search`,
	);

	results.push({
		signal: "structural-search-underuse",
		label: "structural_search underused — read/edit on code files without AST query",
		wastedTokens: actualWaste,
		wastedCost: sumDollarCost(codeTouches),
		occurrences: codeTouches.length,
		details,
		context: {
			files: [...uniquePaths],
		},
	});

	return results;
}
