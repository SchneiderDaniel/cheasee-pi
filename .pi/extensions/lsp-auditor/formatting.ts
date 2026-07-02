/**
 * Formatting utilities for LSP Auditor diagnostics.
 *
 * All pure functions — zero I/O. Imported by lsp-client.ts and run-pre-audit.ts.
 * Testable without any setup.
 */

import type { LspDiagnostic, AuditResult } from "./types.ts";

// ─── Severity Mapping ────────────────────────────────────────────────

/** Severity name → LSP diagnostic severity number (1=Error, 2=Warning, 3=Information, 4=Hint) */
export function severityValue(severity: string): number {
	switch (severity.toLowerCase()) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "information":
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 99;
	}
}

/** Threshold string → max severity value to include */
export function thresholdValue(threshold: string): number {
	switch (threshold.toLowerCase()) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
		case "information":
			return 4; // "info" = show all including hints
		default:
			return 2; // default to error+warning
	}
}

// ─── Formatting ──────────────────────────────────────────────────────

/**
 * Format diagnostics into a compact, human-readable message.
 * Grouped by file, sorted by line.
 */
export function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, LspDiagnostic[]>();
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
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

// ─── Filtering ───────────────────────────────────────────────────────

/**
 * Filter diagnostics by severity threshold string.
 * "error" → only errors, "warning" → errors+warnings, "info" → all.
 */
export function filterBySeverity(diagnostics: LspDiagnostic[], threshold: string): LspDiagnostic[] {
	if (!diagnostics || !Array.isArray(diagnostics)) return [];
	const maxVal = thresholdValue(threshold || "warning");
	return diagnostics.filter((d) => severityValue(d.severity) <= maxVal);
}

