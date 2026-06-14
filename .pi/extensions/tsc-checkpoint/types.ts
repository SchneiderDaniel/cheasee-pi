/**
 * tsc-checkpoint — Shared type definitions
 *
 * Cross-module types used by adapter, watcher, format, and checkpoint modules.
 * Zero dependencies — importable from any module without side effects.
 */

export interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
	/** Absolute path to the file (resolved from tsconfig dir) */
	filePath: string;
}

export interface TscWatchOptions {
	/** Polling interval in ms (reserved for future polling mode) */
	pollInterval?: number;
}

export interface DiagnosticTrend {
	current: number;
	previous: number;
	direction: "improved" | "regressed" | "stable";
	delta: number;
}

export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
	trend?: DiagnosticTrend;
}
