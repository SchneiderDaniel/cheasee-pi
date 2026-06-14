/**
 * tsc-checkpoint — Display formatters
 *
 * Pure functions for formatting diagnostics and trends for display.
 * Depends only on types.ts — no adapter or watcher dependencies.
 */

import type { TscDiagnostic, DiagnosticTrend } from "./types.ts";

/**
 * Format a diagnostic trend for display.
 */
export function formatTrend(trend: DiagnosticTrend): string {
	const arrow = trend.direction === "regressed" ? "↑" : trend.direction === "improved" ? "↓" : "→";
	return `${trend.current} errors (${arrow} ${trend.delta}, was ${trend.previous})`;
}

/**
 * Format diagnostics as clickable file paths with line numbers.
 */
export function formatDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (diagnostics.length === 0) return "";
	return diagnostics
		.map((d) => {
			const codePart = d.code ? ` (${d.code})` : "";
			return `${d.filePath}, Line ${d.line}: [${d.severity}] ${d.message}${codePart}`;
		})
		.join("\n");
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
			const directionLabel =
				trend.direction === "regressed"
					? "regressed ↑"
					: trend.direction === "improved"
						? "improved ↓"
						: "stable →";
			summary = `${baseSummary} (${directionLabel} ${trend.delta}, was ${trend.previous})`;
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

/**
 * @deprecated Use `formatDiagnostics` instead.
 * Kept for backward compatibility with supervisor pipeline.
 * Uses the old format: grouped by file, sorted by line, with relative paths.
 */
export function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file (use `file` field for backward compat)
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
