/**
 * tsc-checkpoint — Adapter interface and TypeScript watch compiler implementation
 *
 * Defines TscWatchAdapter seam for testability and provides the real
 * TypeScriptWatchAdapter that wraps ts.createWatchProgram().
 */

import ts from "typescript";
import { resolve, dirname } from "node:path";
import type { TscDiagnostic } from "./types.ts";

// ═══════════════════════════════════════════════════════════════════════
// Adapter Interface
// ═══════════════════════════════════════════════════════════════════════

export interface TscWatchAdapter {
	/** Start watching a tsconfig. Returns true if started, false if already running. */
	start(tsconfigPath: string): boolean;
	/** Stop the watch process. */
	stop(): void;
	/** Whether the watcher is currently running. */
	isRunning(): boolean;
	/** Get the latest cached diagnostics. */
	getDiagnostics(): TscDiagnostic[];
	/** Register a callback for when diagnostics change. */
	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void;
}

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

// ═══════════════════════════════════════════════════════════════════════
// Real Adapter: TypeScript Watch Compiler API
// ═══════════════════════════════════════════════════════════════════════

class TypeScriptWatchAdapter implements TscWatchAdapter {
	private watchProgram: ts.WatchOfConfigFile<ts.BuilderProgram> | undefined;
	private diagnostics: TscDiagnostic[] = [];
	private running = false;
	private listeners: Array<(diagnostics: TscDiagnostic[]) => void> = [];
	private tsconfigDir = "";

	start(tsconfigPath: string): boolean {
		if (this.running) return false;
		this.tsconfigDir = dirname(tsconfigPath);
		this.diagnostics = [];

		const host = ts.createWatchCompilerHost(
			tsconfigPath,
			{ noEmit: true },
			ts.sys,
			ts.createEmitAndSemanticDiagnosticsBuilderProgram,
			(diagnostic: ts.Diagnostic) => {
				if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
				this.handleDiagnostic(diagnostic);
			},
			(
				diagnostic: ts.Diagnostic,
				newLine: string,
				options: ts.CompilerOptions,
				errorCount?: number,
			) => {
				if (errorCount === undefined) {
					// New compilation cycle starting — clear previous diagnostics
					this.diagnostics = [];
				} else {
					// Compilation complete — notify listeners
					this.notifyListeners();
				}
			},
		);

		this.watchProgram = ts.createWatchProgram(host);
		this.running = true;
		return true;
	}

	private handleDiagnostic(diagnostic: ts.Diagnostic): void {
		const diag = diagnosticToTscDiagnostic(diagnostic, this.tsconfigDir);
		if (diag) {
			this.diagnostics.push(diag);
		}
	}

	private notifyListeners(): void {
		const snapshot = [...this.diagnostics];
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	stop(): void {
		this.watchProgram?.close();
		this.running = false;
		this.watchProgram = undefined;
	}

	isRunning(): boolean {
		return this.running;
	}

	getDiagnostics(): TscDiagnostic[] {
		return [...this.diagnostics];
	}

	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void {
		this.listeners.push(callback);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Default Adapter Factory
// ═══════════════════════════════════════════════════════════════════════

export function createDefaultAdapter(): TscWatchAdapter {
	return new TypeScriptWatchAdapter();
}
