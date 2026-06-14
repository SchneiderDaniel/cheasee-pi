/**
 * renderer.ts — Custom TUI renderer for structural-analyzer.
 *
 * Displays human-readable search results with OSC 8 hyperlinked file paths
 * in TUI mode. LLM-visible content (result.content) is unchanged.
 *
 * This is a pure function accepting a minimal interface so it can be unit
 * tested without importing pi framework types.
 */

import path from "node:path";
import { Text, hyperlink, type Component } from "@earendil-works/pi-tui";

/**
 * Maximum number of individual results to display in expanded TUI view.
 */
export const RENDER_EXPANDED_LIMIT = 20;

/**
 * Maximum number of individual results to display in collapsed TUI view.
 */
export const RENDER_COLLAPSED_LIMIT = 5;

/**
 * Custom renderResult for structural_search tool.
 *
 * Displays human-readable search results with OSC 8 hyperlinked file paths
 * in TUI mode. LLM-visible content (result.content) is unchanged.
 */
export function renderStructuralSearchResult(
	result: { content: Array<{ type: string; text: string }>; details: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg: (color: string, text: string) => string },
	context: { cwd: string },
): Component {
	// ═══════════════════════════════════════════════════════════
	// Guard: partial / streaming result
	// ═══════════════════════════════════════════════════════════
	if (options.isPartial) {
		return new Text(theme.fg("muted", "Searching..."), 1, 1);
	}

	// ═══════════════════════════════════════════════════════════
	// Guard: error or missing details
	// ═══════════════════════════════════════════════════════════
	const details = result.details as Record<string, unknown> | undefined;
	if (!details || details.success === false) {
		const errorText = result.content?.[0]?.text ?? "Error: Search failed";
		return new Text(theme.fg("error", errorText), 1, 1);
	}

	const matches = (details.matches as number) ?? 0;
	const results =
		(details.results as Array<{ file: string; lines: string; snippet: string }>) ?? [];
	const truncated = Boolean(details.truncated);
	const totalMatches = (details.totalMatches as number) ?? matches;

	// ═══════════════════════════════════════════════════════════
	// Guard: no matches
	// ═══════════════════════════════════════════════════════════
	if (matches === 0 || results.length === 0) {
		return new Text(theme.fg("muted", "No matches found"), 1, 1);
	}

	// ═══════════════════════════════════════════════════════════
	// Build formatted output
	// ═══════════════════════════════════════════════════════════
	const lines: string[] = [];
	const displayLimit = options.expanded ? RENDER_EXPANDED_LIMIT : RENDER_COLLAPSED_LIMIT;

	// Summary line
	const matchWord = totalMatches === 1 ? "match" : "matches";
	lines.push(theme.fg("success", `Structural search: ${totalMatches} ${matchWord}`));

	// Match detail lines
	const displayedResults = results.slice(0, displayLimit);
	for (const match of displayedResults) {
		const absPath = path.resolve(context.cwd, match.file);
		const lineStart = match.lines.split("-")[0]!;
		const uri = `file://localhost${absPath}:${lineStart}`;
		const hyperlinkedPath = hyperlink(uri, match.file);
		const lineInfo = theme.fg("dim", `:${match.lines}`);

		// Truncate long snippets for display
		const snippet = match.snippet.length > 100 ? match.snippet.slice(0, 99) + "…" : match.snippet;

		lines.push(`  ${hyperlinkedPath}${lineInfo}`);
		lines.push(`    ${snippet}`);
	}

	// Truncation notice when the full result set exceeds what we display
	if (truncated || totalMatches > results.length) {
		lines.push("");
		lines.push(
			theme.fg(
				"warning",
				`Showing ${displayedResults.length} of ${totalMatches} matches. Refine the search pattern to narrow results.`,
			),
		);
	}

	return new Text(lines.join("\n"), 1, 1);
}
