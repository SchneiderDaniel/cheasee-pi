/**
 * renderer/session-stats.ts — metadata-side session stats accumulation.
 *
 * parseSessionStats feeds both the .md renderer's sibling walk (via
 * report.ts → buildMetadata → metadata.json) and downstream metadata. The
 * single-pass accumulation is split into per-entry accumulators (Clean Code
 * ch. 3 — small functions), reproducing the original byte-identical results
 * (golden-characterized).
 *
 * Named session-stats.ts (not stats.ts) to avoid collision with the sibling
 * session-logger/stats.ts module.
 */

import { createPerTurnState, flushTurn } from "../per-turn.ts";
import type { PerTurnState } from "../per-turn.ts";
import { handleModelChanges } from "../session-utils.ts";
import { loadSessionEntries } from "./parse.ts";

// ── Parsed session data (used by metadata + markdown) ──

export interface ParsedSessionStats {
	sessionId: string;
	timestamp: string;
	cwd: string;
	version: number;
	parentSession?: string;
	entryCount: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	compactions: number;
	toolStats: Record<string, { calls: number; errors: number; totalDurationMs: number }>;
	subagentToolStats?: Record<
		string,
		Record<string, { calls: number; errors: number; totalDurationMs: number }>
	>;
	fileModifications: Array<{ action: string; path: string; timestamp: string; size?: number }>;
	perTurnTokens: Array<{
		turnIndex: number;
		tokens: number;
		cost: number;
		toolCount: number;
		errorCount: number;
	}>;
}

type ToolStat = { calls: number; errors: number; totalDurationMs: number };

/** Mutable state threaded through the per-entry accumulators. */
interface StatsAccumulator {
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	compactions: number;
	toolCounts: Record<string, ToolStat>;
	subagentToolStats: Record<string, Record<string, ToolStat>>;
	fileMods: Array<{ action: string; path: string; timestamp: string; size?: number }>;
	turnState: PerTurnState;
}

function createStatsAccumulator(): StatsAccumulator {
	return {
		modelChanges: [],
		thinkingChanges: [],
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		totalCost: 0,
		compactions: 0,
		toolCounts: {},
		subagentToolStats: {},
		fileMods: [],
		turnState: createPerTurnState(),
	};
}

/** Accumulate a `message` entry: assistant token/file tracking, toolResult counts, turn boundaries. */
function accumulateMessageStats(acc: StatsAccumulator, entry: any): void {
	const msg = entry.message ?? {};
	const role = msg.role;

	// Token tracking from assistant messages
	if (role === "assistant") {
		const usage = msg.usage;
		if (usage) {
			acc.inputTokens += usage.input ?? 0;
			acc.outputTokens += usage.output ?? 0;
			acc.cacheRead += usage.cacheRead ?? 0;
			acc.cacheWrite += usage.cacheWrite ?? 0;
			acc.totalTokens += usage.totalTokens ?? 0;
			const cost = usage.cost?.total ?? 0;
			acc.totalCost += cost;
			acc.turnState.currentTurnTokens += usage.totalTokens ?? 0;
			acc.turnState.currentTurnCost += cost;
		}

		// File modifications from tool calls
		for (const c of msg.content ?? []) {
			if (c.type === "toolCall") {
				const action =
					c.name === "read"
						? "read"
						: c.name === "write"
							? "write"
							: c.name === "edit"
								? "edit"
								: null;
				if (action) {
					acc.fileMods.push({
						action,
						path: c.arguments?.path ?? "?",
						timestamp: entry.timestamp ?? new Date().toISOString(),
						size: action === "write" ? c.arguments?.content?.length : undefined,
					});
				}
			}
		}
	}

	// Tool result tracking
	if (role === "toolResult") {
		const tn = msg.toolName ?? "?";
		if (!acc.toolCounts[tn]) acc.toolCounts[tn] = { calls: 0, errors: 0, totalDurationMs: 0 };
		acc.toolCounts[tn].calls++;
		if (msg.isError) acc.toolCounts[tn].errors++;
		acc.turnState.currentTurnToolCount++;
		if (msg.isError) acc.turnState.currentTurnErrorCount++;
	}

	// Turn boundaries
	if (role === "user") {
		flushTurn(acc.turnState);
		acc.turnState.currentTurnIndex++;
	} else if (role === "assistant" && acc.turnState.currentTurnIndex < 0) {
		acc.turnState.currentTurnIndex = 0;
	}
}

/** Accumulate a `custom` entry: subagent tool-complete merges into flat + per-agent stats. */
function accumulateCustomStats(acc: StatsAccumulator, entry: any): void {
	const details = entry.details as Record<string, unknown> | undefined;
	if (
		entry.customType === "supervisor" &&
		details?.eventType === "tool-complete" &&
		details?.toolName &&
		typeof details.toolName === "string"
	) {
		const toolName = details.toolName;
		const isError = !!details.isError;
		const durationMs = typeof details.toolDurationMs === "number" ? details.toolDurationMs : 0;
		const agentName =
			details?.agentName && typeof details.agentName === "string" ? details.agentName : "?";

		// Merge into flat toolStats
		if (!acc.toolCounts[toolName])
			acc.toolCounts[toolName] = { calls: 0, errors: 0, totalDurationMs: 0 };
		acc.toolCounts[toolName].calls++;
		if (isError) acc.toolCounts[toolName].errors++;
		acc.toolCounts[toolName].totalDurationMs += durationMs;

		// Build per-agent breakdown
		if (!acc.subagentToolStats[agentName]) acc.subagentToolStats[agentName] = {};
		if (!acc.subagentToolStats[agentName][toolName])
			acc.subagentToolStats[agentName][toolName] = { calls: 0, errors: 0, totalDurationMs: 0 };
		acc.subagentToolStats[agentName][toolName].calls++;
		if (isError) acc.subagentToolStats[agentName][toolName].errors++;
		acc.subagentToolStats[agentName][toolName].totalDurationMs += durationMs;
	}
}

/** Dispatch one JSONL entry to the matching accumulator; unknown types skipped. */
function accumulateParsedEntry(acc: StatsAccumulator, entry: any): void {
	if (entry.type === "compaction") {
		acc.compactions++;
	} else if (entry.type === "message") {
		accumulateMessageStats(acc, entry);
	} else if (entry.type === "custom") {
		accumulateCustomStats(acc, entry);
	}
}

/** Parse a .jsonl session file and extract statistics for metadata. */
export function parseSessionStats(filepath: string): ParsedSessionStats | null {
	const loaded = loadSessionEntries(filepath);
	if (!loaded) return null;

	const acc = createStatsAccumulator();

	handleModelChanges(loaded.entries, acc.modelChanges, acc.thinkingChanges);

	for (const entry of loaded.entries) {
		accumulateParsedEntry(acc, entry);
	}
	flushTurn(acc.turnState);

	const header = loaded.entries[0];
	const hasSubagentTools = Object.keys(acc.subagentToolStats).length > 0;

	return {
		sessionId: header.id ?? "?",
		timestamp: header.timestamp ?? "?",
		cwd: header.cwd ?? "?",
		version: header.version ?? 0,
		parentSession: header.parentSession,
		entryCount: loaded.entries.length,
		tokens: {
			input: acc.inputTokens,
			output: acc.outputTokens,
			cacheRead: acc.cacheRead,
			cacheWrite: acc.cacheWrite,
			total: acc.totalTokens,
		},
		cost: acc.totalCost,
		modelChanges: acc.modelChanges,
		thinkingChanges: acc.thinkingChanges,
		compactions: acc.compactions,
		toolStats: acc.toolCounts,
		subagentToolStats: hasSubagentTools ? acc.subagentToolStats : undefined,
		fileModifications: acc.fileMods,
		perTurnTokens: acc.turnState.perTurnTokens,
	};
}
