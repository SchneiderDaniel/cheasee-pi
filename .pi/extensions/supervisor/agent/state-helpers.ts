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

/**
 * Default consecutive failure threshold for circuit breaker.
 */
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;

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
 * Result of a recordToolResult call.
 */
export interface RecordToolResult {
	tripped: boolean;
	count: number;
	toolName: string;
}

/**
 * Record a tool execution result (success or error) and update the per-tool
 * consecutive failure counter. On success, the counter for that tool is reset
 * to 0. On error, the counter is incremented. If the counter reaches the
 * threshold, the circuit breaker trips.
 *
 * This is a pure state mutation helper — no I/O, no side effects beyond state.
 */
export function recordToolResult(
	state: AgentRunState,
	toolName: string,
	isError: boolean,
): RecordToolResult {
	const threshold = state.consecutiveFailureThreshold || DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

	if (isError) {
		const current = (state.consecutiveToolFailures.get(toolName) ?? 0) + 1;
		state.consecutiveToolFailures.set(toolName, current);

		if (current >= threshold && !state.circuitBroken) {
			state.circuitBroken = true;
			state.circuitBrokenTool = toolName;
			return { tripped: true, count: current, toolName };
		}

		// If circuit is already broken by the SAME tool, signal tripped
		// (stays tripped, counter keeps incrementing).
		// If circuit is broken by a DIFFERENT tool, this tool hasn't
		// reached threshold yet — return tripped=false for per-tool isolation.
		if (state.circuitBroken && state.circuitBrokenTool === toolName) {
			return { tripped: true, count: current, toolName };
		}

		return { tripped: false, count: current, toolName };
	} else {
		// Success — reset counter for this tool
		state.consecutiveToolFailures.set(toolName, 0);
		return { tripped: false, count: 0, toolName };
	}
}
