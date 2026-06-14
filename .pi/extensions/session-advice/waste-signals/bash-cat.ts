/**
 * bash-cat.ts — D4: bash cat/head/tail where read tool exists
 *
 * Uses BashCommand from agent-harness for accurate command classification.
 * Pure function: takes SessionData, returns WasteSignal[].
 *
 * Domain layer: imports from agent-harness (covered by candidate #784).
 */

import { BashCommand } from "../../agent-harness/lib/bash-command.ts";
import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { sumTokenCost, sumDollarCost } from "../token-utils.ts";

/**
 * Detect bash commands that use cat/head/tail for file reading instead of the read tool.
 */
export function detectBashCat(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const bashReadCalls: SessionEntry[] = [];

	for (const e of data.entries) {
		if (e.toolName !== "bash") continue;
		const cmd = e.text ?? "";
		if (new BashCommand(cmd).isFileRead()) {
			bashReadCalls.push(e);
		}
	}

	if (bashReadCalls.length > 0) {
		const waste = sumTokenCost(bashReadCalls);
		const estimatedReadCost = bashReadCalls.length * 30;
		const actualWaste = Math.max(0, waste - estimatedReadCost);
		const details = bashReadCalls.map(
			(e) =>
				`bash cat/head/tail instead of read (turn ${e.turnIndex}): ${(e.text ?? "").slice(0, 80)}`,
		);
		results.push({
			signal: "bash-cat",
			label: "bash cat/head/tail instead of read",
			wastedTokens: actualWaste,
			wastedCost: sumDollarCost(bashReadCalls),
			occurrences: bashReadCalls.length,
			details,
			context: { toolName: "bash" },
		});
	}

	return results;
}
