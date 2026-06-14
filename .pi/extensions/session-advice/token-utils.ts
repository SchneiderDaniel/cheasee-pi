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

/** Get total assist cost for a list of entries (sum of assistantCost or chars/4). */
export function sumTokenCost(entries: SessionEntry[]): number {
	return entries.reduce((sum, e) => {
		if (e.assistantCost) return sum + e.assistantCost;
		if (e.text) return sum + charsToTokens(e.text);
		return sum + 100; // default overhead
	}, 0);
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
