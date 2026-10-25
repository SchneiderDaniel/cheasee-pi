// ─── Budget guards ──────────────────────────────────────────────
// The tool-call and token budgets checked at every `message_end`. Split out of
// handlers.ts (issue #2033).

import type { AgentRunState } from "../../config/types.ts";

/** Mark the run over budget (either guard); reasons accumulate. */
export function applyBudgets(state: AgentRunState): void {
	if (state.maxToolCalls > 0 && state.toolCount >= state.maxToolCalls) {
		state.budgetExceeded = true;
		state.budgetExceededReason = `Tool call limit reached: ${state.toolCount}/${state.maxToolCalls}`;
	}
	if (state.agentTokenBudget > 0 && state.tokenCount >= state.agentTokenBudget) {
		state.budgetExceeded = true;
		const reason = `Token budget exceeded: ${state.tokenCount}/${state.agentTokenBudget}`;
		state.budgetExceededReason = state.budgetExceededReason
			? `${state.budgetExceededReason}; ${reason}`
			: reason;
	}
}
