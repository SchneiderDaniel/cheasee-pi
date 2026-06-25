/**
 * bash-grep.ts — D3: bash | grep/rg/find where ripgrep_search exists
 *
 * Uses isBashSearch from lib/bash-query.ts for accurate command classification.
 * Pure function: takes SessionData, returns WasteSignal[].
 *
 * Domain layer: imports from lib/bash-query.ts (shared classification module).
 */

import { isBashSearch } from "../../lib/bash-query.ts";
import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { sumTokenCost, sumDollarCost } from "../token-utils.ts";

/**
 * Detect bash commands that use grep/rg for file searching instead of ripgrep_search.
 */
export function detectBashGrep(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const bashGrepCalls: SessionEntry[] = [];

	for (const e of data.entries) {
		if (e.toolName !== "bash") continue;
		const cmd = e.text ?? "";
		if (isBashSearch(cmd)) {
			bashGrepCalls.push(e);
		}
	}

	if (bashGrepCalls.length > 0) {
		const waste = sumTokenCost(bashGrepCalls);
		// Subtract estimated ripgrep_search cost (~50 tokens per call)
		const estimatedSearchCost = bashGrepCalls.length * 50;
		const actualWaste = Math.max(0, waste - estimatedSearchCost);
		const details = bashGrepCalls.map(
			(e) =>
				`bash | grep instead of ripgrep_search (turn ${e.turnIndex}): ${(e.text ?? "").slice(0, 80)}`,
		);
		results.push({
			signal: "bash-grep",
			label: "bash | grep instead of ripgrep_search",
			wastedTokens: actualWaste,
			wastedCost: sumDollarCost(bashGrepCalls),
			occurrences: bashGrepCalls.length,
			details,
			context: { toolName: "bash" },
		});
	}

	return results;
}
