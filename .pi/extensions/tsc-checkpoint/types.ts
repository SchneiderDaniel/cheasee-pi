/**
 * tsc-checkpoint — Shared type definitions
 *
 * Cross-module types used by adapter, watcher, format, and checkpoint modules.
 * Zero dependencies — importable from any module without side effects.
 */

import type { TscDiagnostic } from "../lib/tsc-types.ts";

export type { TscDiagnostic };

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
