/**
 * error-loop.ts — D5: Tool error followed by retrying same tool with same args
 *
 * Fixes for #623 / #617:
 * - Arg comparison: flags only when retries share same args (different args = strategy change)
 * - Proportional cost split: wastes only retries beyond the first (first retry is reasonable)
 * - False-positive filtering: skips single errors, different-args retries
 *
 * Co-locates stableJsonKey and groupBy (single-consumer helpers).
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { sumTokenCost, sumDollarCost } from "../token-utils.ts";

/** Stable JSON key for args comparison. */
function stableJsonKey(args: Record<string, unknown> | undefined): string {
	if (!args) return "__no_args__";
	try {
		const keys = Object.keys(args).sort();
		return JSON.stringify(args, keys);
	} catch {
		return "__no_args__";
	}
}

/** Group entries by a string key. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; entries: T[] }> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const group = map.get(key);
		if (group) {
			group.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	return Array.from(map.entries()).map(([key, entries]) => ({ key, entries }));
}

/**
 * Detect error → retry loops with same args (no strategy change).
 *
 * NOTE: Uses `data.entries.indexOf(err)` for reference identity lookup.
 * Tests must pass reference-identical entries from `data.entries`.
 */
export function detectErrorLoop(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const errors = data.entries.filter((e) => e.isError);

	for (const err of errors) {
		const errIdx = data.entries.indexOf(err);
		if (errIdx < 0) continue;

		const window = data.entries.slice(errIdx + 1, errIdx + 9);
		const sameToolRetries = window.filter((e) => e.toolName === err.toolName);

		if (sameToolRetries.length < 2) continue;

		// Compare args among retries — if args differ, it's strategy change not loop
		// Group retries by args key; pick the largest group
		const groups = groupBy(sameToolRetries, (e) => stableJsonKey(e.args));
		let largest: { key: string; entries: SessionEntry[] } | undefined;
		for (const g of groups) {
			if (!largest || g.entries.length > largest.entries.length) {
				largest = g;
			}
		}

		if (!largest || largest.entries.length < 2) continue;

		// Proportional waste: only retries beyond the first are wasteful
		const wastefulRetries = largest.entries.slice(1);
		const waste = sumTokenCost(wastefulRetries);
		const cost = sumDollarCost(wastefulRetries);
		const details = [
			`\`${err.toolName}\` errored turn ${err.turnIndex}, retried ${largest.entries.length}x with same args — first retry is reasonable, ${wastefulRetries.length} subsequent retries wasted`,
		];
		results.push({
			signal: "error-loop",
			label: "Error retry loop",
			wastedTokens: waste,
			wastedCost: cost,
			occurrences: wastefulRetries.length,
			details,
			context: {
				toolName: err.toolName,
				turnRange: [
					err.turnIndex,
					largest.entries[largest.entries.length - 1]?.turnIndex ?? err.turnIndex,
				],
			},
		});
	}

	return results;
}
