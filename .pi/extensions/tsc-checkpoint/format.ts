/**
 * tsc-checkpoint — Display formatters
 *
 * Pure functions for formatting diagnostics and trends for display.
 * Depends only on types.ts — no adapter or watcher dependencies.
 */

import type { TscDiagnostic, DiagnosticTrend } from "./types.ts";

/**
 * Direction → label mapping, shared by TUI and JSON/structured output.
 * Keyed on the literal direction union so a new direction value fails
 * compilation until a label is added here.
 */
const DIRECTION_LABELS: Record<DiagnosticTrend["direction"], { tui: string; json: string }> = {
	regressed: { tui: "⚠️ regression", json: "regressed ↑" },
	improved: { tui: "✓ improved", json: "improved ↓" },
	stable: { tui: "→ stable", json: "stable →" },
};

/**
 * Resolve the display label for a trend direction in a given output style.
 * Call sites select the style ("tui" for markdown, "json" for structured).
 */
export function directionLabel(
	direction: DiagnosticTrend["direction"],
	style: "tui" | "json",
): string {
	return DIRECTION_LABELS[direction][style];
}

/**
 * Format diagnostics as grouped, sorted, developer-readable output.
 *
 * Groups diagnostics by file, sorts files alphabetically, sorts
 * diagnostics by line then column within each file.
 * Truncates individual messages longer than 500 characters.
 * Returns empty string for null, undefined, or empty input.
 *
 * Format per line: `file, Line N: [Error] message (code)`
 */
export function formatDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file (use `file` field for relative paths)
	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${d.file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

/**
 * Format diagnostics as structured JSON output for programmatic consumers.
 * Used in JSON, RPC, and print modes.
 */
export function formatDiagnosticsJson(
	diagnostics: TscDiagnostic[],
	trend?: DiagnosticTrend,
): {
	diagnostics: TscDiagnostic[];
	summary: string;
	fileCount: number;
} {
	let summary: string;
	if (diagnostics.length === 0) {
		summary = "No type errors detected";
	} else {
		const baseSummary = `${diagnostics.length} type error(s) found`;
		if (trend) {
			summary = `${baseSummary} (${directionLabel(trend.direction, "json")} ${trend.delta}, was ${trend.previous})`;
		} else {
			summary = baseSummary;
		}
	}
	return {
		diagnostics,
		summary,
		fileCount: new Set(diagnostics.map((d) => d.filePath)).size,
	};
}
