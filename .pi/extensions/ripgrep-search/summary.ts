// ─── ripgrep-search: structured summaries ─────────────────────────
// Split out of index.ts (issue #2005 Long File refactor). Builds the
// human-readable summary text and the structuredContent payload.
// index.ts re-exports these names.

import { truncateLine } from "@earendil-works/pi-coding-agent";
import type { RgResult, RipgrepSearchOutput } from "./types.ts";

const DEFAULT_DISPLAY_RESULTS = 10;

/**
 * Build a structured human-readable summary of search results.
 * Replaces the old JSON output format with a concise summary
 * showing top-N results, truncated indicator, and file counts.
 */
export function buildStructuredSummary(
	searchResult: RgResult,
	searcherName: string,
	query: string,
	directory: string,
	maxDisplay: number = DEFAULT_DISPLAY_RESULTS,
): { text: string; details: Record<string, unknown> } {
	const totalReturned = searchResult.total_returned;

	if (totalReturned === 0) {
		return {
			text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
			details: { success: true, total_returned: 0, searcher: searcherName },
		};
	}

	// Count unique files
	const uniqueFiles = new Set(searchResult.results.map((r) => r.file));

	let text = `${searcherName} search results for query: ${query}\n`;
	text += `Directory: ${directory}\n`;
	text += `Matches returned: ${totalReturned}`;
	text += ` across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}\n\n`;

	// Show top-N results (each line truncated to MAX_LINE_LENGTH for safety)
	const displayResults = searchResult.results.slice(0, maxDisplay);
	for (let i = 0; i < displayResults.length; i++) {
		const r = displayResults[i]!;
		const truncatedText = truncateLine(r.text).text;
		text += `${i + 1}. ${r.file}:${r.line}:${r.column}:${truncatedText}\n`;
	}

	const resultsTruncated = totalReturned > maxDisplay;
	let truncatedIndicator = "";
	if (resultsTruncated) {
		truncatedIndicator = `\n[Showing first ${maxDisplay} of ${totalReturned} results across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}.]`;
		text += truncatedIndicator;
	}

	const details: Record<string, unknown> = {
		success: true,
		searcher: searcherName,
		total_returned: totalReturned,
		unique_files: uniqueFiles.size,
		truncated: resultsTruncated,
	};

	return { text, details };
}

/**
 * Build the `structuredContent` payload declared by `RipgrepSearchOutputSchema`.
 *
 * Rebuilt at the request boundary on every exit (including cache hits): the
 * cache stores only the domain `RgResult`, so `query`/`directory`/`searcher`
 * always come from the request scope rather than the cached entry.
 */
export function buildStructuredContent(
	searchResult: RgResult,
	searcherName: string,
	query: string,
	directory: string,
): RipgrepSearchOutput {
	return {
		query,
		searcher: searcherName,
		directory,
		total_returned: searchResult.total_returned,
		results: searchResult.results.map((r) => ({ ...r })),
		truncated: searchResult.truncated ?? false,
	};
}

/**
 * Error-path variant of {@link buildStructuredContent}: identical shape with
 * zeroed result fields, plus `error` (stderr) and `code` (exit code).
 * `code` is omitted when the exit code is unknown (null).
 */
export function buildErrorStructuredContent(
	searcherName: string,
	query: string,
	directory: string,
	error: string,
	code: number | null,
): RipgrepSearchOutput {
	return {
		query,
		searcher: searcherName,
		directory,
		total_returned: 0,
		results: [],
		truncated: false,
		error,
		...(code !== null ? { code } : {}),
	};
}
