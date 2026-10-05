// ─── Session Result Assembly ──────────────────────────────────────
// Adapters for converting between AgentRunResult and AgentToolResult<SubagentDetails>.
// Formerly also contained in-process builders (buildAgentRunResult, buildRawOutputFromMessages)
// which were removed in Phase 3.

import type { AgentRunResult } from "../config/types.ts";
import type { AgentToolResult, SubagentDetails, NestedCall, NestedCalls } from "../subagent/types.ts";
import { combineErrorCount } from "./nested-stats.ts";

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
 * - failedToolCount folded with nestedErrors into details.errorCount (shared combineErrorCount)
 * - nestedErrors → details.nestedErrorCount; nestedCalls → details.nestedCalls
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
			thinkingLevel: result.thinkingLevel,
			taskPrompt: devTask || "",
			budgetExceeded: result.budgetExceeded,
			errorCount: combineErrorCount(result.failedToolCount, result.nestedErrors),
			nestedErrorCount: result.nestedErrors,
			nestedCalls: normalizeNestedCalls(result.nestedCalls),
			thinkingOutput: result.thinkingOutput,
		},
	};
}

/** pi records nested status as "ok" | "error" | "unfinished"; preserve all three. */
function normalizeNestedStatus(status: unknown): NestedCall["status"] {
	return status === "ok" || status === "unfinished" ? status : "error";
}

/**
 * Map pi's native `NestedToolCalls` (or the supervisor's own DTO) onto the
 * renderer DTO: `arguments` → `args`, unknown statuses → "error".
 */
function normalizeNestedCalls(raw: unknown): NestedCalls | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as { calls?: unknown; complete?: unknown };
	if (!Array.isArray(r.calls)) return undefined;
	const calls: NestedCall[] = r.calls.map((c: any) => {
		const call: NestedCall = {
			name: typeof c?.name === "string" ? c.name : "tool",
			status: normalizeNestedStatus(c?.status),
		};
		const args = c?.args ?? c?.arguments;
		if (args && typeof args === "object" && !Array.isArray(args)) {
			call.args = args as Record<string, unknown>;
		}
		if (typeof c?.durationMs === "number") call.durationMs = c.durationMs;
		if (typeof c?.error === "string") call.error = c.error;
		return call;
	});
	return { calls, complete: r.complete !== false };
}
