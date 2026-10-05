// ─── Nested-call stats ────────────────────────────────────────────
// Pure count/truncation/label policy for pi's bounded `nestedCalls` record.
// No TUI or host imports — renderers and adapters both consume this.

import type { NestedCalls } from "../subagent/types.ts";

/** Counts derived from a subagent result's nested-call record. */
export interface NestedStats {
	/** Calls present in the bounded record (may be < true total when capped). */
	recorded: number;
	ok: number;
	err: number;
	unfinished: number;
	/** True nested error total (recorder counts before the cap); ≥ err. */
	totalErrors: number;
	truncated: boolean;
}

/** Minimal input shape; `SubagentDetails` satisfies it structurally. */
export interface NestedStatsInput {
	nestedCalls?: NestedCalls;
	nestedErrorCount?: number;
}

/**
 * Derive stats from a result's nested-call record. `unfinished` is tracked
 * separately (pi is three-valued) and never folded into `err`.
 * `totalErrors` falls back to the recorded error count when the true total
 * was not reported.
 */
export function buildNestedStats(details: NestedStatsInput | undefined): NestedStats {
	const calls = details?.nestedCalls?.calls ?? [];
	let ok = 0;
	let err = 0;
	let unfinished = 0;
	for (const call of calls) {
		if (call.status === "ok") ok++;
		else if (call.status === "unfinished") unfinished++;
		else err++;
	}
	return {
		recorded: calls.length,
		ok,
		err,
		unfinished,
		totalErrors: details?.nestedErrorCount ?? err,
		truncated: details?.nestedCalls?.complete === false,
	};
}

/**
 * Compact nested-call summary: `  nested: N calls (X ok, Y err)` plus an
 * `unfinished` segment when present and `(truncated)` when capped.
 * Returns `""` when nothing was recorded.
 */
export function formatNestedStats(stats: NestedStats): string {
	if (stats.recorded === 0) return "";
	const noun = stats.recorded === 1 ? "call" : "calls";
	const parts = [`${stats.ok} ok`, `${stats.totalErrors} err`];
	if (stats.unfinished > 0) parts.push(`${stats.unfinished} unfinished`);
	const truncated = stats.truncated ? " (truncated)" : "";
	return `  nested: ${stats.recorded} ${noun} (${parts.join(", ")})${truncated}`;
}

/**
 * Fold nested errors into a displayed error count without reclassifying
 * success. Undefined when neither source reported errors (preserves the
 * established `errorCount === undefined` pin).
 */
export function combineErrorCount(failed?: number, nested?: number): number | undefined {
	if (failed === undefined && nested === undefined) return undefined;
	return (failed ?? 0) + (nested ?? 0);
}
