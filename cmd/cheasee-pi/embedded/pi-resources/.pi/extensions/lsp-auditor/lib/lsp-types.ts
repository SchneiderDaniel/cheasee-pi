/**
 * Minimal LSP protocol types for lsp-auditor.ts
 *
 * Covers the subset of LSP used by the auditor extension.
 * For full protocol types, use `vscode-languageserver-protocol`.
 */

// ─── LSP Basic Types ─────────────────────────────────────────────────

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnosticData {
	range: LspRange;
	severity?: number; // 1=Error, 2=Warning, 3=Information, 4=Hint
	message: string;
	source?: string;
	code?: string | number;
}

export interface LspPublishDiagnosticsParams {
	uri: string;
	diagnostics: LspDiagnosticData[];
}

// ─── Type guards ─────────────────────────────────────────────────────

/** Check if value is a non-null object (not array) */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLspDiagnosticData(obj: unknown): obj is LspDiagnosticData {
	return isObject(obj) && isObject(obj.range) && typeof obj.message === "string";
}

export function isLspPublishDiagnosticsParams(obj: unknown): obj is LspPublishDiagnosticsParams {
	return isObject(obj) && typeof obj.uri === "string" && Array.isArray(obj.diagnostics);
}
