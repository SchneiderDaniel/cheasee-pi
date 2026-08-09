import type { Usage } from "@earendil-works/pi-ai";
import { createPerTurnState, flushTurn } from "./per-turn.ts";
import type { TurnStats, PerTurnState } from "./per-turn.ts";
import { handleModelChanges } from "./session-utils.ts";

export type { TurnStats } from "./per-turn.ts";

export interface ToolExecution {
	toolCallId: string;
	toolName: string;
	startTime: number;
	endTime: number | null;
	isError: boolean;
	resultSize: number;
}

export interface StatsSnapshot {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	compactionCount: number;
	toolExecutions: ToolExecution[];
	perTurnTokens: TurnStats[];
	fileModifications: Array<{
		action: "read" | "write" | "edit";
		path: string;
		timestamp: string;
		size?: number;
	}>;
}

export interface SessionStats {
	addUsage(usage: Usage): void;
	seedStats(sm: { getEntries(): any[] }): void;
	reset(): void;
	getSnapshot(): StatsSnapshot;
	incrementCompaction(): void;
	modelChange(provider: string, modelId: string): void;
	thinkingChange(level: string): void;
	recordToolStart(toolCallId: string, toolName: string): void;
	recordToolEnd(toolCallId: string, isError: boolean, resultSize: number): void;
	recordTurnStart(turnIndex: number): void;
	recordTurnEnd(): void;
	recordFileModification(action: "read" | "write" | "edit", path: string, size?: number): void;
}

/** Aggregate tool executions into a summary map with durations. */
export function computeToolStats(
	executions: Array<{
		toolName: string;
		isError: boolean;
		startTime: number;
		endTime: number | null;
	}>,
): Record<string, { calls: number; errors: number; totalDurationMs: number }> {
	const stats: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};
	for (const exec of executions) {
		if (!stats[exec.toolName]) {
			stats[exec.toolName] = { calls: 0, errors: 0, totalDurationMs: 0 };
		}
		stats[exec.toolName].calls++;
		if (exec.isError) stats[exec.toolName].errors++;
		if (exec.endTime != null) {
			stats[exec.toolName].totalDurationMs += exec.endTime - exec.startTime;
		}
	}
	return stats;
}

export function createSessionStats(): SessionStats {
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let modelChanges: Array<{ time: string; model: string }> = [];
	let thinkingChanges: Array<{ time: string; level: string }> = [];
	let compactionCount = 0;
	let toolExecutions: ToolExecution[] = [];
	let fileModifications: Array<{
		action: "read" | "write" | "edit";
		path: string;
		timestamp: string;
		size?: number;
	}> = [];

	// Current turn tracking — uses shared PerTurnState from per-turn.ts
	const turnState: PerTurnState = createPerTurnState();

	// Track tool call IDs to execution objects
	const pendingTools: Map<string, ToolExecution> = new Map();

	return {
		addUsage(usage: Usage) {
			if (!usage) return;
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const cost = usage.cost?.total ?? 0;

			totalInputTokens += input;
			totalOutputTokens += output;
			totalCacheRead += cacheRead;
			totalCacheWrite += cacheWrite;
			totalCost += cost;

			// Also track per-turn
			turnState.currentTurnTokens += input + output + cacheRead + cacheWrite;
			turnState.currentTurnCost += cost;
		},

		seedStats(sm: { getEntries(): any[] }) {
			const entries = sm.getEntries();
			handleModelChanges(entries, modelChanges, thinkingChanges);

			for (const entry of entries) {
				if (entry.type === "message") {
					if (entry.message.role === "assistant") this.addUsage(entry.message.usage);
				} else if (entry.type === "compaction") {
					compactionCount++;
				}
			}
		},

		reset() {
			totalInputTokens = 0;
			totalOutputTokens = 0;
			totalCacheRead = 0;
			totalCacheWrite = 0;
			totalCost = 0;
			modelChanges = [];
			thinkingChanges = [];
			compactionCount = 0;
			toolExecutions = [];
			fileModifications = [];
			// Reset per-turn state via factory
			const fresh = createPerTurnState();
			turnState.currentTurnIndex = fresh.currentTurnIndex;
			turnState.currentTurnTokens = fresh.currentTurnTokens;
			turnState.currentTurnCost = fresh.currentTurnCost;
			turnState.currentTurnToolCount = fresh.currentTurnToolCount;
			turnState.currentTurnErrorCount = fresh.currentTurnErrorCount;
			turnState.perTurnTokens.length = 0;
			pendingTools.clear();
		},

		getSnapshot(): StatsSnapshot {
			// Flush current turn if there's one open
			if (turnState.currentTurnIndex >= 0 && turnState.currentTurnTokens > 0) {
				const last = turnState.perTurnTokens[turnState.perTurnTokens.length - 1];
				if (!last || last.turnIndex !== turnState.currentTurnIndex) {
					flushTurn(turnState);
				}
			}
			return {
				totalInputTokens,
				totalOutputTokens,
				totalCacheRead,
				totalCacheWrite,
				totalCost,
				modelChanges: [...modelChanges],
				thinkingChanges: [...thinkingChanges],
				compactionCount,
				toolExecutions: [...toolExecutions],
				perTurnTokens: [...turnState.perTurnTokens],
				fileModifications: [...fileModifications],
			};
		},

		incrementCompaction() {
			compactionCount++;
		},

		modelChange(provider: string, modelId: string) {
			modelChanges.push({
				time: new Date().toISOString(),
				model: `${provider}/${modelId}`,
			});
		},

		thinkingChange(level: string) {
			thinkingChanges.push({ time: new Date().toISOString(), level });
		},

		recordToolStart(toolCallId: string, toolName: string) {
			const exec: ToolExecution = {
				toolCallId,
				toolName,
				startTime: Date.now(),
				endTime: null,
				isError: false,
				resultSize: 0,
			};
			pendingTools.set(toolCallId, exec);
			toolExecutions.push(exec);
		},

		recordToolEnd(toolCallId: string, isError: boolean, resultSize: number) {
			const exec = pendingTools.get(toolCallId);
			if (!exec) return; // already ended or never started — no-op
			exec.endTime = Date.now();
			exec.isError = isError;
			exec.resultSize = resultSize;
			pendingTools.delete(toolCallId);
			turnState.currentTurnToolCount++;
			if (isError) turnState.currentTurnErrorCount++;
		},

		recordTurnStart(turnIndex: number) {
			flushTurn(turnState);
			turnState.currentTurnIndex = turnIndex;
		},

		recordTurnEnd() {
			flushTurn(turnState);
			turnState.currentTurnIndex = -1;
		},

		recordFileModification(action: "read" | "write" | "edit", path: string, size?: number) {
			fileModifications.push({
				action,
				path,
				timestamp: new Date().toISOString(),
				size,
			});
		},
	};
}
