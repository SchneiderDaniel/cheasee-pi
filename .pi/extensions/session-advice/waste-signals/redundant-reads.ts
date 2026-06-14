/**
 * redundant-reads.ts — D1: Same file path read within 2 turns
 *
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { getEntryPath, sumTokenCost, sumDollarCost } from "../token-utils.ts";

function shortPath(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Detect files read multiple times within a 2-turn window.
 */
export function detectRedundantReads(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const reads: Array<{
		path: string;
		turnIndex: number;
		entry: SessionEntry;
		reported?: boolean;
	}> = [];

	for (const e of data.entries) {
		if (e.toolName !== "read") continue;
		const p = getEntryPath(e);
		if (!p) continue;

		const redundant = reads.filter(
			(r) =>
				r.path === p &&
				Math.abs(r.turnIndex - e.turnIndex) <= 2 &&
				r.turnIndex !== e.turnIndex &&
				!r.reported,
		);
		if (redundant.length > 0) {
			const allEntries = [...redundant.map((r) => r.entry), e];
			const redundantEntries = allEntries.slice(1);
			const waste = sumTokenCost(redundantEntries);
			const file = shortPath(p);
			const firstTurn = redundant[0].turnIndex;
			const lastTurn = e.turnIndex;
			const totalCalls = redundant.length + 1;
			results.push({
				signal: "redundant-read",
				label: "Redundant file reads",
				wastedTokens: waste,
				wastedCost: sumDollarCost(redundantEntries),
				occurrences: redundant.length,
				details: [
					`${file} read ${totalCalls}x in ${totalCalls} calls (turns ${firstTurn}-${lastTurn})`,
				],
				context: { files: [p], turnRange: [firstTurn, lastTurn] },
			});
			// Mark redundant entries as reported so each entry's cost
			// appears in exactly one signal's redundantEntries.
			for (const r of redundant) r.reported = true;
		}

		reads.push({
			path: p,
			turnIndex: e.turnIndex,
			entry: e,
		});
	}

	return results;
}
