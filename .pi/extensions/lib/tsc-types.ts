/**
 * tsc-types.ts — Shared TypeScript type-check types.
 *
 * Extracted from tsc-checkpoint/index.ts. Decision logic migrated to
 * supervisor/checks/audit-gate-decision.ts.
 * to eliminate the cross-extension direct import from supervisor → tsc-checkpoint.
 *
 * Layer: domain — zero pi dependencies. Pure types only.
 */

// ── Types ──

/** A single TypeScript diagnostic from tsc compilation. */
export interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
	/** Absolute path to the file (resolved from tsconfig dir). */
	filePath: string;
}

/** Result from a tsc checkpoint run (one-shot or watch). */
export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

/** Decision output for the pipeline supervisor. */
export interface TscCheckpointDecision {
	nextStatus: string;
	note: string;
	tscTriggered: boolean;
}
