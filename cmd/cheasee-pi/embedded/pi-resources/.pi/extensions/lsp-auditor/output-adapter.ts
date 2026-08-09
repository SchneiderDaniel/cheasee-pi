/**
 * Output adapter — mode-adaptive formatting for LSP diagnostics.
 *
 * Pure functions mapping diagnostics + mode → mode-specific output shapes.
 * No I/O, no Pi API imports — testable without any setup.
 *
 * Modes:
 *   - "tui" with hasUI=true  → string with file:// URIs for clickable paths
 *   - "tui" with hasUI=false → plain text (no URI links)
 *   - "rpc" / "json"         → StructuredDiagnostics object
 *   - "print" / others       → plain text string
 */

import { formatDiagnostics, pushLineBlock, truncateMessage } from "./formatting.ts";
import type { LspDiagnostic, StructuredDiagnostics } from "./types.ts";

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Format diagnostics appropriate for the given execution mode.
 *
 * @param diagnostics - Array of LSP diagnostics to format
 * @param mode - Execution mode ("tui", "rpc", "json", "print", or other)
 * @param worktreePath - Absolute path to the worktree root (for URI generation)
 * @param hasUI - Whether the current mode supports UI interactions
 * @returns String for text modes, StructuredDiagnostics for structured modes
 */
export function formatForMode(
	diagnostics: LspDiagnostic[] | null | undefined,
	mode: string,
	worktreePath: string,
	hasUI: boolean,
): string | StructuredDiagnostics {
	// Defensive: null/undefined → empty result
	if (!diagnostics || !Array.isArray(diagnostics) || diagnostics.length === 0) {
		if (mode === "rpc" || mode === "json") {
			return { files: [] };
		}
		return "";
	}

	switch (mode) {
		case "tui":
			if (hasUI) {
				return formatTuiWithUris(diagnostics, worktreePath);
			}
			return formatPlainText(diagnostics);

		case "rpc":
		case "json":
			return formatStructured(diagnostics);

		default:
			// "print" and any unknown mode → plain text
			return formatPlainText(diagnostics);
	}
}

// ─── Formatting Helpers ──────────────────────────────────────────────

/**
 * Format diagnostics with file:// URIs for clickable paths in TUI mode.
 * Each diagnostic is shown as a clickable file path with line/col info.
 */
function formatTuiWithUris(diagnostics: LspDiagnostic[], worktreePath: string): string {
	if (diagnostics.length === 0) return "";

	const byFile = groupByFile(diagnostics);

	const blocks: string[] = [];
	for (const [filePath, diags] of byFile) {
		const uri = pathToFileUri(filePath);
		pushLineBlock(blocks, diags, (d) =>
			`${uri}:${d.line}:${d.column} — [${d.severity}] ${truncateMessage(d.message)}`,
		);
	}

	return blocks.join("\n");
}

/**
 * Format diagnostics as plain text (no URI links).
 * Delegates to formatDiagnostics() — single canonical plain-text renderer.
 */
function formatPlainText(diagnostics: LspDiagnostic[]): string {
	return formatDiagnostics(diagnostics);
}

/**
 * Format diagnostics as a StructuredDiagnostics object for RPC/JSON modes.
 */
function formatStructured(diagnostics: LspDiagnostic[]): StructuredDiagnostics {
	if (diagnostics.length === 0) return { files: [] };

	const byFile = groupByFile(diagnostics);

	const files: StructuredDiagnostics["files"] = [];
	for (const [filePath, diags] of byFile) {
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));
		const issues = diags.map((d) => ({
			line: d.line,
			col: d.column,
			severity: d.severity,
			message: d.message,
		}));
		files.push({ path: filePath, issues });
	}

	return { files };
}

// ─── Shared Utilities ────────────────────────────────────────────────

/**
 * Group diagnostics by file path, preserving insertion order of files.
 */
function groupByFile(diagnostics: LspDiagnostic[]): Map<string, LspDiagnostic[]> {
	const byFile = new Map<string, LspDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file);
		if (list) {
			list.push(d);
		} else {
			byFile.set(d.file, [d]);
		}
	}
	return byFile;
}

/**
 * Convert an absolute file path to a file:// URI with proper encoding.
 * Handles unicode characters in paths.
 */
function pathToFileUri(filePath: string): string {
	// Ensure we start with /
	if (!filePath.startsWith("/")) {
		filePath = "/" + filePath;
	}
	return "file://" + encodePathForUri(filePath);
}

/**
 * Encode a file path for use in a URI.
 * Only encodes characters that are not valid in the path component.
 * We skip encoding / and common path characters.
 */
function encodePathForUri(path: string): string {
	// Encode each character except /, letters, digits, and common path chars
	let result = "";
	for (let i = 0; i < path.length; i++) {
		const ch = path[i]!;
		if (ch === "/" || ch === "." || ch === "-" || ch === "_" || ch === "~") {
			result += ch;
		} else if (/[a-zA-Z0-9]/.test(ch)) {
			result += ch;
		} else {
			// Encode as UTF-8 then percent-encode each byte
			const encoded = encodeURIComponent(ch);
			result += encoded;
		}
	}
	return result;
}
