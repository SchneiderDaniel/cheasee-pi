// ─── Instrumentation — structured counters and phase timing ────────
// Phase 3: Per-turn event counts, token/tool tracking, phase timing
// snapshots. Pure data collection — no TUI or Pi API dependencies.

import type { AgentPhase } from "../config/types.ts";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Snapshot of instrumentation counters at a point in time.
 */
export interface InstrumentSnapshot {
	/** Total events processed (all kinds) */
	eventsTotal: number;
	/** Count of tool execution start events */
	toolCalls: number;
	/** Count of tool errors */
	toolErrors: number;
	/** Count of thinking deltas received */
	thinkingDeltas: number;
	/** Count of text deltas received */
	textDeltas: number;
	/** Total tokens (cumulative from usage data) */
	tokenCount: number;
	/** Milliseconds spent in each phase */
	phaseTiming: Record<AgentPhase, number>;
	/** Current phase at snapshot time */
	currentPhase: AgentPhase;
	/** Phase transition counter */
	phaseTransitions: number;
	/** Timestamp of snapshot creation */
	timestamp: number;
}

export interface InstrumenterHandle {
	/** Increment counter for a received event kind */
	incrementEvent: (kind: string) => void;
	/** Track phase timing — marks transition from one phase to another */
	trackPhase: (newPhase: AgentPhase) => void;
	/** Update token count */
	setTokenCount: (count: number) => void;
	/** Take a snapshot of current counters */
	snapshot: () => InstrumentSnapshot;
	/** Record a tool error (used when tool_execution_end has isError) */
	recordToolError: () => void;
}

// ─── createInstrumenter ────────────────────────────────────────────

/**
 * Create an instrumenter for tracking event counters and phase timing.
 *
 * Maintains internal counters that can be snapshot at any time.
 * Phase timing tracks cumulative time spent in each phase.
 */
export function createInstrumenter(): InstrumenterHandle {
	let eventsTotal = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let thinkingDeltas = 0;
	let textDeltas = 0;
	let tokenCount = 0;
	let phaseTransitions = 0;
	let currentPhase: AgentPhase = "idle";
	let lastPhaseTransitionTime = Date.now();
	const phaseTiming: Record<AgentPhase, number> = {
		idle: 0,
		thinking: 0,
		tool: 0,
		text: 0,
	};

	/**
	 * Accumulate time spent in the current phase up to now.
	 */
	function accumulateCurrentPhase(): void {
		const now = Date.now();
		phaseTiming[currentPhase] += now - lastPhaseTransitionTime;
		lastPhaseTransitionTime = now;
	}

	const handle: InstrumenterHandle = {
		incrementEvent: (kind: string) => {
			eventsTotal++;
			switch (kind) {
				case "tool_execution_start":
					toolCalls++;
					break;
				case "tool_execution_end":
					// tool execution end is counted separately from toolCalls
					break;
				case "thinking_delta":
					thinkingDeltas++;
					break;
				case "text_delta":
					textDeltas++;
					break;
			}
		},

		trackPhase: (newPhase: AgentPhase) => {
			if (newPhase === currentPhase) return;
			accumulateCurrentPhase();
			currentPhase = newPhase;
			phaseTransitions++;
		},

		setTokenCount: (count: number) => {
			tokenCount = count;
		},

		recordToolError: () => {
			toolErrors++;
		},

		snapshot: (): InstrumentSnapshot => {
			// Snapshot accumulates current phase timing up to now
			const now = Date.now();
			const timing = { ...phaseTiming };
			timing[currentPhase] += now - lastPhaseTransitionTime;

			return {
				eventsTotal,
				toolCalls,
				toolErrors,
				thinkingDeltas,
				textDeltas,
				tokenCount,
				phaseTiming: timing,
				currentPhase,
				phaseTransitions,
				timestamp: now,
			};
		},
	};

	return handle;
}
