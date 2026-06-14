/**
 * no-batch.ts — D6: 3+ consecutive same-tool calls in different turns (could batch)
 *
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal } from "../types.ts";
import { sumTokenCost } from "../token-utils.ts";

/**
 * Detect consecutive same-tool calls spread across multiple turns.
 * Flags when 3+ consecutive calls could have been batched into fewer turns.
 */
export function detectNoBatch(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const tools = data.entries.filter((e) => e.toolName);

	let runStart = 0;
	for (let i = 1; i <= tools.length; i++) {
		const a = tools[i]?.toolName;
		const b = tools[i - 1]?.toolName;
		if (a === b) continue;

		const runLen = i - runStart;
		if (runLen >= 3 && b) {
			const runTools = tools.slice(runStart, i);
			const startTurn = runTools[0]?.turnIndex ?? 0;
			const endTurn = runTools[runTools.length - 1]?.turnIndex ?? 0;

			if (startTurn === endTurn) continue; // same turn = already batched

			// Turn overhead: ~600 tokens per extra turn
			const extraTurns = endTurn - startTurn;
			const overhead = extraTurns * 600;
			const details = [
				`\`${b}\` called ${runLen}x consecutively across ${extraTurns + 1} turns (turns ${startTurn}-${endTurn}) — could batch into fewer turns`,
			];
			results.push({
				signal: "no-batch",
				label: "Unbatched consecutive calls",
				wastedTokens: overhead,
				wastedCost: 0, // hard to measure dollar cost of turn overhead
				occurrences: extraTurns,
				details,
				context: { toolName: b, turnRange: [startTurn, endTurn] },
			});
		}
		runStart = i;
	}

	return results;
}
