// ─── Agent State Helpers ──────────────────────────────────────────
// Pure state-invariant helpers for AgentRunState.
// Owns: pushLog(), MAX_FULL_LOG constant.
//
// pushLog was extracted from the deleted agent/stream.ts. It belongs in
// the Entity/State-Invariant layer — next to AgentRunState type, not
// in the adapter layer — because it mutates a state object with bounded
// FIFO semantics. The adapter layer (event/adapter.ts) handles external
// format conversion; state mutation helpers belong here.

import type { AgentRunState } from "../config/types.ts";

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Maximum number of log entries in state.fullLog.
 * When exceeded, oldest entries are shifted (FIFO).
 */
export const MAX_FULL_LOG = 500;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Push a log entry to state.fullLog with bounded size.
 * When the log exceeds MAX_FULL_LOG entries, the oldest entry is removed.
 */
export function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > MAX_FULL_LOG) state.fullLog.shift();
}

/**
 * Create an AgentRunState with default values.
 * Called by runAgentInProcess and runAgentSubprocess for consistent state creation.
 * Budget params default to 0 (unlimited) for backward compatibility.
 */
export function createAgentRunState(
	startedAt: number,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	thinkingLevel?: string,
): AgentRunState {
	return {
		toolCount: 0,
		failedToolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		toolCalls: [],
		phase: "idle",
		startedAt,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: maxToolCalls ?? 0,
		agentTokenBudget: agentTokenBudget ?? 0,
		thinkingLevel: thinkingLevel?.trim() || undefined,
	};
}
