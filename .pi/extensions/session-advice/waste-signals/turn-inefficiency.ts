/**
 * turn-inefficiency.ts — D7: Turns with 0 file changes but many tool calls
 *
 * Fixed for #629:
 * - Bug 1: allReadFiles built incrementally per turn (novelty detection works)
 * - Bug 2: Discovery tools expanded beyond just read
 * - Bug 3: Threshold raised to >=15 tool calls, combined discovery check
 *
 * Co-locates DISCOVERY_TOOLS and isBashSearchOrRead (single-consumer helpers).
 * Pure function: takes SessionData, returns WasteSignal[].
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionData, WasteSignal, SessionEntry } from "../types.ts";
import { getEntryPath, sumTokenCost, sumDollarCost } from "../token-utils.ts";

/** Tools that perform codebase/external discovery (not waste). */
const DISCOVERY_TOOLS = new Set([
	"ripgrep_search",
	"structural_search",
	"web_search",
	"web_crawl",
	"ask_user",
]);

/** True if a bash command is a search/read operation (grep, cat, head, tail). */
function isBashSearchOrRead(cmd: string): boolean {
	if (!cmd) return false;
	const low = cmd.toLowerCase();
	// Check piped grep/rg from file-reading commands only
	if (/^(cat|head|tail|less|more)\s/.test(low) && /\|\s*grep\b|\|\s*rg\b/.test(low)) return true;
	// Check file read commands
	if (
		low.startsWith("cat ") ||
		low.startsWith("head ") ||
		low.startsWith("tail ") ||
		low.startsWith("less ") ||
		low.startsWith("more ")
	)
		return true;
	// Check using rg/grep/find as primary command
	if (low.startsWith("grep ") || low.startsWith("rg ") || low.startsWith("find ")) return true;
	return false;
}

/**
 * Detect turns with >=15 tool calls, 0 file changes, and 0 discovery events.
 * Such turns suggest the agent is re-processing known information rather than discovering new content.
 */
export function detectTurnInefficiency(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const turns = new Map<number, SessionEntry[]>();

	for (const e of data.entries) {
		if (!turns.has(e.turnIndex)) turns.set(e.turnIndex, []);
		turns.get(e.turnIndex)!.push(e);
	}

	// Build set of turns that changed files
	const fileChangeTurns = new Set<number>();
	for (const e of data.entries) {
		if (
			e.toolName === "edit" ||
			e.toolName === "write" ||
			e.toolName === "writeIfEmpty" ||
			e.toolName === "editExisting"
		) {
			fileChangeTurns.add(e.turnIndex);
		}
	}

	// pre-collect read files per turn (path -> Set<turn>)
	const readFilesPerTurn = new Map<number, Set<string>>();
	for (const e of data.entries) {
		if (e.toolName === "read" && e.type === "tool_use") {
			const p = getEntryPath(e);
			if (!p) continue;
			if (!readFilesPerTurn.has(e.turnIndex)) readFilesPerTurn.set(e.turnIndex, new Set());
			readFilesPerTurn.get(e.turnIndex)!.add(p);
		}
	}

	// Build allReadFiles incrementally (Bug 1 fix)
	const allReadFiles = new Set<string>();

	// Sort turns by index for incremental processing
	const sortedTurns = [...turns.entries()].sort(([a], [b]) => a - b);

	for (const [turnIndex, entries] of sortedTurns) {
		if (turnIndex < 0) continue;
		if (fileChangeTurns.has(turnIndex)) {
			// Still accumulate reads for novelty tracking in future turns
			const readsThisTurn = readFilesPerTurn.get(turnIndex);
			if (readsThisTurn) {
				for (const f of readsThisTurn) allReadFiles.add(f);
			}
			continue;
		}

		// Count tool_use entries as tool calls (Bug 3: count calls, not all entries)
		const toolCalls = entries.filter((e) => e.type === "tool_use" && e.toolName);
		if (toolCalls.length < 15) {
			// Accumulate reads even if below threshold
			const readsThisTurn = readFilesPerTurn.get(turnIndex);
			if (readsThisTurn) {
				for (const f of readsThisTurn) allReadFiles.add(f);
			}
			continue;
		}

		// Check for discovery events (Bug 2: expanded beyond just read)
		let hasDiscovery = false;

		// Check 1: Novel file reads (Bug 1: uses incremental allReadFiles)
		const readsThisTurn = readFilesPerTurn.get(turnIndex);
		if (readsThisTurn) {
			for (const f of readsThisTurn) {
				if (!allReadFiles.has(f)) {
					hasDiscovery = true;
					break;
				}
			}
		}

		// Check 2: Discovery tool calls (ripgrep_search, structural_search, etc.)
		if (!hasDiscovery) {
			for (const e of toolCalls) {
				if (DISCOVERY_TOOLS.has(e.toolName ?? "")) {
					hasDiscovery = true;
					break;
				}
				// Check 3: Non-search/read bash calls
				if (e.toolName === "bash") {
					const cmd = (e.args?.command as string) ?? e.text ?? "";
					if (!isBashSearchOrRead(cmd)) {
						hasDiscovery = true;
						break;
					}
				}
			}
		}

		// Accumulate reads for future novelty tracking
		if (readsThisTurn) {
			for (const f of readsThisTurn) allReadFiles.add(f);
		}

		if (hasDiscovery) continue; // discovery turns are OK

		// Flag: >=15 tool calls, 0 file changes, 0 discovery
		const waste = sumTokenCost(toolCalls);
		const details = [
			`Turn ${turnIndex}: ${toolCalls.length} tool calls, 0 file changes, 0 discovery events`,
		];
		results.push({
			signal: "turn-inefficiency",
			label: "Inefficient turns",
			wastedTokens: waste,
			wastedCost: sumDollarCost(toolCalls),
			occurrences: 1,
			details,
			context: { turnRange: [turnIndex, turnIndex] },
		});
	}

	return results;
}
