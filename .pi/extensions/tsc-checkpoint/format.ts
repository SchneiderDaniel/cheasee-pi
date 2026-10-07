/**
 * tsc-checkpoint — Display formatters
 *
 * Pure functions for formatting diagnostics and trends for display.
 * Depends only on types.ts — no adapter or watcher dependencies.
 */

import type { TscDiagnostic, DiagnosticTrend } from "./types.ts";
import { renderDiagnostics } from "../lib/diagnostics-format.ts";

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
 * Delegates grouping, alphabetical file sort, blank-line joining, and
 * 500-char truncation to the shared renderer in lib/diagnostics-format.ts;
 * this module owns only the tsc-specific `(code)` suffix.
 * Returns empty string for null, undefined, or empty input.
 *
 * Format per line: `file, Line N: [Error] message (code)`
 */
export const formatDiagnostics = (diagnostics: TscDiagnostic[]): string =>
	renderDiagnostics(diagnostics, {
		suffix: (d) => (d.code ? ` (${d.code})` : ""),
	});

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
