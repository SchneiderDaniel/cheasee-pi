/**
 * tsc-checkpoint — Diagnostic mapping utilities
 *
 * Pure functions for mapping TypeScript diagnostics to the TscDiagnostic shape
 * and resolving file paths. These are the only remaining exports from what
 * was formerly the adapter module.
 *
 * The TscWatchAdapter interface, TypeScriptWatchAdapter class, and
 * createDefaultAdapter factory have been removed — they were a speculative
 * seam (one real implementation + one test mock) that added pass-through
 * complexity without real polymorphism. The consolidated watcher in
 * watcher.ts owns ts.createWatchProgram directly.
 */

import ts from "typescript";
import { resolve } from "node:path";
import type { TscDiagnostic } from "./types.ts";

// ═══════════════════════════════════════════════════════════════════════
// File Path Resolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Resolve a diagnostic's file path to absolute.
 * If already absolute, return as-is. Otherwise, resolve against tsconfigDir.
 */
export function resolveDiagnosticFilePath(file: string, tsconfigDir: string): string {
	if (file.startsWith("/")) return file;
	if (/^[A-Za-z]:[/\\]/.test(file)) return file; // Windows absolute
	return resolve(tsconfigDir, file);
}

// ═══════════════════════════════════════════════════════════════════════
// Diagnostic Mapping
// ═══════════════════════════════════════════════════════════════════════

/**
 * Map a TypeScript diagnostic to the TscDiagnostic shape.
 * Returns undefined if the diagnostic has no source file (e.g. global errors).
 */
export function diagnosticToTscDiagnostic(
	diagnostic: ts.Diagnostic,
	configDir: string,
): TscDiagnostic | undefined {
	const file = diagnostic.file;
	if (!file) return undefined;

	const start = diagnostic.start ?? 0;
	const { line, character } = file.getLineAndCharacterOfPosition(start);
	const message =
		typeof diagnostic.messageText === "string"
			? diagnostic.messageText
			: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

	return {
		file: file.fileName,
		line: line + 1,
		column: character + 1,
		severity: "Error",
		message,
		code: `TS${diagnostic.code}`,
		filePath: resolveDiagnosticFilePath(file.fileName, configDir),
	};
}
