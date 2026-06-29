// ─── Session Result Assembly ──────────────────────────────────────
// Adapters for converting between AgentRunResult and AgentToolResult<SubagentDetails>.
// Formerly also contained in-process builders (buildAgentRunResult, buildRawOutputFromMessages)
// which were removed in Phase 3.

import type { AgentRunResult } from "../config/types.ts";
import type { AgentToolResult, SubagentDetails } from "../subagent/types.ts";

// ─── Adapter: AgentRunResult → AgentToolResult<SubagentDetails> ──────
// Converts the pipeline's AgentRunResult (returned by runAgent) to the subagent
// tool result format (eventType: "subagent-result") for rich message rendering.

/**
 * Convert an AgentRunResult (from runAgent) to AgentToolResult<SubagentDetails>
 * for use as eventType: "subagent-result" in pi.sendMessage.
 *
 * Maps fields:
 * - textOutput/output → content[0].text
 * - agentName/success/statusLabel/summaryLine → details.*
 * - thinkingOutput → details.thinkingOutput
 * - failedToolCount → details.errorCount
 * - model/inputTokens/outputTokens/cacheRead/cacheWrite/cost/turnCount → details.*
 * - toolCalls/toolResults → empty arrays (runAgent does not track these)
 * - devTask argument → details.taskPrompt
 */
export function convertAgentRunToToolResult(
	result: AgentRunResult,
	devTask?: string,
): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: result.textOutput || result.output || "" }],
		details: {
			agentName: result.agentName,
			success: result.success,
			statusLabel: result.success ? "SUCCESS" : "FAILED",
			summaryLine: result.summaryLine || "",
			model: result.model || "",
			inputTokens: result.inputTokens || 0,
			outputTokens: result.outputTokens || 0,
			cacheRead: result.cacheRead || 0,
			cacheWrite: result.cacheWrite || 0,
			cost: result.cost || 0,
			turnCount: result.turnCount || 0,
			durationMs: result.durationMs,
			toolCalls: [],
			toolResults: [],
			taskPrompt: devTask || "",
			budgetExceeded: result.budgetExceeded,
			circuitBroken: result.circuitBroken,
			circuitBrokenTool: result.circuitBrokenTool,
			errorCount: result.failedToolCount ?? undefined,
			thinkingOutput: result.thinkingOutput,
		},
	};
}
