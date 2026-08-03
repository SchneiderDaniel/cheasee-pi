// ─── Budget enforcement → kill policy ─────────────────────────────
// Budget flags are set by event/adapter handlers (state.budgetExceeded);
// this module reacts by killing the subprocess exactly once. Kill cause
// is classified from state, not the signal — budget kills, timeout
// kills, and external kills all surface identically in 'close'
// (code=null, signal="SIGTERM").

import type { AgentRunState } from "../../config/types.ts";
import type { ChildHandle } from "./spawn.ts";

/**
 * Kill the subprocess when the agent exceeded its budget and the child
 * has not already exited. handle.kill is idempotent, so repeated
 * budget-exceeding events (e.g. several message_end lines before close)
 * still send exactly one SIGTERM.
 */
export function maybeKillOnBudgetExceeded(state: AgentRunState, handle: ChildHandle): void {
	if (state.budgetExceeded && !handle.childExited) {
		handle.kill("SIGTERM");
	}
}

/**
 * Classify the kill cause from state. budgetExceeded is the source of
 * truth; anything else is labeled timeout (current "[Timeout: …]"
 * behavior — kept byte-for-byte until a relabel is approved).
 */
export function classifyKillReason(state: AgentRunState): "budget" | "timeout" {
	return state.budgetExceeded ? "budget" : "timeout";
}
