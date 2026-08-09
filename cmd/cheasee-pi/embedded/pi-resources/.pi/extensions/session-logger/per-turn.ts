/**
 * per-turn.ts — Shared per-turn token tracking for session-logger
 *
 * Extracted from duplicate definitions in renderer.ts and stats.ts.
 * Both modules manipulate the same per-turn state shape; this module
 * provides the single source of truth for flushTurn() and TurnStats.
 */

// ── Types ──

export interface TurnStats {
	turnIndex: number;
	tokens: number;
	cost: number;
	toolCount: number;
	errorCount: number;
}

export interface PerTurnState {
	currentTurnIndex: number;
	currentTurnTokens: number;
	currentTurnCost: number;
	currentTurnToolCount: number;
	currentTurnErrorCount: number;
	perTurnTokens: TurnStats[];
}

// ── Factory ──

export function createPerTurnState(): PerTurnState {
	return {
		currentTurnIndex: -1,
		currentTurnTokens: 0,
		currentTurnCost: 0,
		currentTurnToolCount: 0,
		currentTurnErrorCount: 0,
		perTurnTokens: [],
	};
}

// ── flushTurn ──

/**
 * Flush accumulated per-turn stats into the perTurnTokens array and reset
 * accumulators to zero.
 *
 * If currentTurnIndex < 0, no entry is pushed (initial state before any
 * turn has started). Accumulators are still reset to zero in all cases.
 *
 * @param state - Mutable per-turn state object to flush and reset.
 */
export function flushTurn(state: PerTurnState): void {
	if (state.currentTurnIndex >= 0) {
		state.perTurnTokens.push({
			turnIndex: state.currentTurnIndex,
			tokens: state.currentTurnTokens,
			cost: state.currentTurnCost,
			toolCount: state.currentTurnToolCount,
			errorCount: state.currentTurnErrorCount,
		});
	}
	state.currentTurnTokens = 0;
	state.currentTurnCost = 0;
	state.currentTurnToolCount = 0;
	state.currentTurnErrorCount = 0;
}
