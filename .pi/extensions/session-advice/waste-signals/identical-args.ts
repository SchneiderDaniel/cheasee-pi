/**
 * identical-args.ts — D2: Same tool + same args 3+ times in last 12 calls
 *
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal } from "../types.ts";
import { sumTokenCost, sumDollarCost } from "../token-utils.ts";

/**
 * Detect identical tool calls with matching args within a sliding window.
 */
export function detectIdenticalArgs(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const calls = data.entries
		.filter((e) => e.toolName && e.args)
		.map((e) => ({
			key: `${e.toolName}|${JSON.stringify(e.args)}`,
			toolName: e.toolName!,
			turnIndex: e.turnIndex,
			entry: e,
		}));

	const window: string[] = [];
	const windowEntries: typeof calls = [];
	for (let i = 0; i < calls.length; i++) {
		const c = calls[i];
		const key = c.key;
		window.push(key);
		windowEntries.push(c);
		if (window.length > 12) {
			window.shift();
			windowEntries.shift();
		}

		const matching = windowEntries.filter((w) => w.key === key);
		if (matching.length >= 3) {
			// Report on first occurrence of the loop
			const waste = sumTokenCost(matching.slice(1).map((m) => m.entry));
			const cost = sumDollarCost(matching.slice(1).map((m) => m.entry));
			results.push({
				signal: "identical-args",
				label: "Identical call loops",
				wastedTokens: waste,
				wastedCost: cost,
				occurrences: matching.length - 1,
				details: [
					`\`${c.toolName}\` identical args ${matching.length}x in last ${window.length} calls (turn ${c.turnIndex})`,
				],
				context: {
					toolName: c.toolName,
					turnRange: [matching[0].turnIndex, matching[matching.length - 1].turnIndex],
				},
			});
			// Clear window to avoid re-reporting
			window.length = 0;
			windowEntries.length = 0;
		}
	}

	return results;
}
