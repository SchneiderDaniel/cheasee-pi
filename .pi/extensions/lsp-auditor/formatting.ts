/**
 * Formatting utilities for LSP Auditor diagnostics.
 *
 * All pure functions — zero I/O. Imported by lsp-client.ts and run-pre-audit.ts.
 * Testable without any setup.
 */

import type { LspDiagnostic } from "./types.ts";

// ─── Shared Diagnostic Rendering (compat re-export) ──────────────────
//
// The renderer lives in lib/diagnostics-format.ts — one implementation for
// lsp-auditor, tsc-checkpoint, and format-on-save. Re-exported here so the
// existing import paths (output-adapter.ts, tests, index.ts) stay stable.
export { truncateMessage, pushLineBlock, formatDiagnostics } from "../lib/diagnostics-format.ts";

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

