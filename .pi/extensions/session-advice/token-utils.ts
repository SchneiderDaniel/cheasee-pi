/**
 * token-utils.ts — Token estimation utilities for waste-signal detectors
 *
 * Shared across all 8 detectors. Single reason to change: token model updates.
 *
 * Domain layer: zero pi dependencies, zero I/O. Pure functions.
 */

import type { SessionEntry } from "./types.ts";

/** Rough tokens from text length (chars/4). */
export function charsToTokens(s: string): number {
	return Math.ceil((s ?? "").length / 4);
}

/**
 * Marginal token cost of one entry — the content it injected into context.
 *
 * Preference order (see issue #1084):
 *   1. `resultTokens` — tokens of the paired toolResult's content. This is the
 *      true cost of a duplicate/unnecessary call: the re-injected file/result
 *      payload. Set by jsonl-parser.ts.
 *   2. `assistantCost` — fallback when no result was paired (truncated sessions).
 *      NOTE: `assistantCost` carries the *full* assistant-message cost incl. the
 *      entire growing prompt; summing it across calls inflates waste ~5-10x,
 *      which is why `resultTokens` is preferred whenever available.
 *   3. `text` length → chars/4 (e.g. synthetic test entries).
 *   4. 100 default overhead.
 */
function tokenCostOf(e: SessionEntry): number {
	if (typeof e.resultTokens === "number" && e.resultTokens > 0) return e.resultTokens;
	if (e.assistantCost && e.assistantCost > 0) return e.assistantCost;
	if (e.text) return charsToTokens(e.text);
	return 100; // default overhead
}

/** Get total marginal token cost for a list of entries. */
export function sumTokenCost(entries: SessionEntry[]): number {
	return entries.reduce((sum, e) => sum + tokenCostOf(e), 0);
}

/** Get total dollar cost for a list of entries. */
export function sumDollarCost(entries: SessionEntry[]): number {
	return entries.reduce((sum, e) => {
		if (e.usage?.cost) return sum + e.usage.cost;
		return sum;
	}, 0);
}

/** Get the path argument from a session entry (from args.path or text). */
export function getEntryPath(e: SessionEntry): string {
	return ((e.args?.path as string) ?? e.text ?? "") as string;
}
