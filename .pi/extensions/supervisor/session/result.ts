// ─── Session Result Assembly ──────────────────────────────────────
// Build AgentRunResult from session state and message history.
// Extracted from agent-session-runner.ts to keep files modular.

import type { AgentRunState, AgentRunResult } from "../config/types.ts";
import { extractTextFromContent, extractSummaryLine } from "../lib/formatting.ts";
import type { AgentToolResult, SubagentDetails } from "../subagent/types.ts";

// ─── Truncation Constants ─────────────────────────────────────────

const MAX_TOOL_INPUT_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_TOTAL_OUTPUT_CHARS = 100_000;

/**
 * Truncate a string with an overflow indicator if it exceeds maxLength.
 */
function truncate(text: string, maxLength: number, label: string): string {
	if (text.length <= maxLength) return text;
	const overflow = text.length - maxLength;
	return text.slice(0, maxLength) + `\n…[+${overflow} more ${label}]\n`;
}

/**
 * Build complete raw output string from session message history.
 * Truncates tool_use.input to 500 chars, tool_result.content to 2000 chars,
 * and total output to 100K chars (Phase 4 optimization).
 */
export function buildRawOutputFromMessages(messages: any[]): string {
	if (!Array.isArray(messages) || messages.length === 0) return "";

	const parts: string[] = [];
	let totalLength = 0;

	for (const msg of messages) {
		if (!msg) continue;

		const role = msg.role || "unknown";
		const toolName = msg.toolName || "";

		if (msg.content && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (!block || typeof block !== "object") continue;

				switch (block.type) {
					case "text": {
						if (block.text) {
							const header = `[${role.toUpperCase()}]`;
							parts.push(header);
							totalLength += header.length + 1;
							if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
							parts.push(block.text);
							totalLength += block.text.length + 1;
						}
						break;
					}
					case "thinking": {
						if (block.thinking) {
							const t =
								typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking);
							const header = `[${role.toUpperCase()} THINKING]`;
							parts.push(header);
							totalLength += header.length + 1;
							if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
							parts.push(t);
							totalLength += t.length + 1;
						}
						break;
					}
					case "tool_use": {
						if (block.name) {
							const header = `[TOOL_USE: ${block.name}]`;
							parts.push(header);
							totalLength += header.length + 1;
							if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
							if (block.input) {
								let inputStr: string;
								if (typeof block.input === "string") {
									inputStr = block.input;
								} else {
									inputStr = JSON.stringify(block.input, null, 2);
								}
								inputStr = truncate(inputStr, MAX_TOOL_INPUT_CHARS, "chars");
								parts.push(inputStr);
								totalLength += inputStr.length + 1;
							}
						}
						break;
					}
					case "tool_result": {
						const header = `[TOOL_RESULT${toolName ? `: ${toolName}` : ""}]`;
						parts.push(header);
						totalLength += header.length + 1;
						if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
						let text = extractTextFromContent(block.content || block.result || "");
						text = truncate(text, MAX_TOOL_RESULT_CHARS, "chars");
						if (text) {
							parts.push(text);
							totalLength += text.length + 1;
						}
						break;
					}
				}

				// Stop processing if we've exceeded the total limit
				if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
			}
		} else if (typeof msg.content === "string") {
			const header = `[${role.toUpperCase()}]`;
			parts.push(header);
			totalLength += header.length + 1;
			if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
			parts.push(msg.content);
			totalLength += msg.content.length + 1;
		}

		if (totalLength >= MAX_TOTAL_OUTPUT_CHARS) break;
	}

	let result = parts.join("\n");
	// Hard cap at 100K chars
	if (result.length > MAX_TOTAL_OUTPUT_CHARS) {
		result = result.slice(0, MAX_TOTAL_OUTPUT_CHARS) + "\n…[truncated: output exceeds 100K chars]";
	}
	return result;
}

/**
 * Build AgentRunResult from session state and messages.
 * Uses full untruncated message content for rawOutput.
 */
export function buildAgentRunResult(
	state: AgentRunState,
	agentName: string,
	success: boolean,
	durationMs: number,
	messages: any[],
): AgentRunResult {
	const textOutput = state.fullLog.join("\n").trim();
	const textOnly = state.textOutputLines.join("\n").trim();
	const rawOutput = buildRawOutputFromMessages(messages);
	const thinkingOutput =
		state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;
	const summaryLine = extractSummaryLine(textOutput, success, agentName);

	// Token fallback: scan messages for assistant usage data.
	// Per-message usage is CUMULATIVE (tokens consumed for entire conversation
	// up to that point, per @earendil-works/pi-ai Usage type). Last assistant
	// message gives total session cost. Summing cumulative values across all
	// messages produces O(N²/2) overcount — root cause of 28M token report
	// for moderate refactor session (GH #314).
	let tokenCount = state.tokenCount;

	// Per-agent usage breakdown extraction
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let cost: number | undefined;
	let turnCount: number | undefined;

	if (Array.isArray(messages) && messages.length > 0) {
		const lastAsstMsg = [...messages].reverse().find((m) => m && m.role === "assistant" && m.usage);
		if (lastAsstMsg?.usage) {
			const u = lastAsstMsg.usage;
			const lastTotal = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
			if (typeof lastTotal === "number" && !Number.isNaN(lastTotal) && lastTotal > 0) {
				tokenCount = Math.max(state.tokenCount, lastTotal);
			}
			// Extract token breakdown
			if (typeof u.input === "number" && !Number.isNaN(u.input)) inputTokens = u.input;
			if (typeof u.output === "number" && !Number.isNaN(u.output)) outputTokens = u.output;
			// Extract cost from usage.cost.total
			if (u.cost && typeof u.cost.total === "number") cost = u.cost.total;
		}

		// Turn count: count assistant messages with usage.input > 0
		turnCount = messages.filter(
			(m) =>
				m &&
				m.role === "assistant" &&
				m.usage &&
				typeof m.usage.input === "number" &&
				m.usage.input > 0,
		).length;
		if (turnCount === 0) turnCount = undefined;
	}

	return {
		output: rawOutput,
		success,
		agentName,
		toolCount: state.toolCount,
		failedToolCount: state.failedToolCount ?? undefined,
		tokenCount: tokenCount + (state.cacheRead || 0) + (state.cacheWrite || 0),
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput: "",
		thinkingOutput,
		budgetExceeded: state.budgetExceeded || undefined,
		// Per-agent usage breakdown
		inputTokens,
		outputTokens,
		cacheRead: state.cacheRead,
		cacheWrite: state.cacheWrite,
		cost,
		turnCount,
	};
}

// ─── Adapter: AgentToolResult → AgentRunResult ──────────────────────
// Converts the subagent tool's result to the pipeline's AgentRunResult format.
// This is a pure function (<10 LOC) called once per agent iteration.
// Lives here (co-located with buildAgentRunResult) because both deal with the same types.

/**
 * Convert a subagent tool result (AgentToolResult<SubagentDetails>) to the
 * pipeline's AgentRunResult format.
 *
 * Maps fields:
 * - details.success → result.success
 * - content[0].text → textOutput, textOnly
 * - details.* → per-agent usage breakdown
 * - toolCalls.length → toolCount
 */
// ─── Adapter: AgentRunResult → AgentToolResult<SubagentDetails> ──────
// Converts the pipeline's AgentRunResult (returned by runAgent) to the subagent
// tool result format (_subagentResult) for rich message rendering.
// Symmetric counterpart to convertToolResultToAgentRunResult above.

/**
 * Convert an AgentRunResult (from runAgent) to AgentToolResult<SubagentDetails>
 * for use as _subagentResult in pi.sendMessage.
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
			errorCount: result.failedToolCount ?? undefined,
			thinkingOutput: result.thinkingOutput,
		},
	};
}

/**
 * Convert a subagent tool result (AgentToolResult<SubagentDetails>) to the
 * pipeline's AgentRunResult format.
 *
 * Maps fields:
 * - details.success → result.success
 * - content[0].text → textOutput, textOnly
 * - details.* → per-agent usage breakdown
 * - toolCalls.length → toolCount
 */
export function convertToolResultToAgentRunResult(
	toolResult: AgentToolResult<SubagentDetails>,
): AgentRunResult {
	const d = toolResult.details;
	const content0 = toolResult.content?.[0];
	const textOutput = content0 && content0.type === "text" ? content0.text : "";
	const summaryLine = d.summaryLine || extractSummaryLine(textOutput, d.success, d.agentName);

	return {
		output: textOutput,
		success: d.success,
		agentName: d.agentName,
		toolCount: d.toolCalls.length,
		failedToolCount: d.errorCount ?? undefined,
		tokenCount:
			(d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0),
		durationMs: d.durationMs,
		textOutput,
		textOnly: textOutput,
		summaryLine,
		errorOutput: d.success ? "" : summaryLine,
		thinkingOutput: undefined,
		budgetExceeded: (d.budgetExceeded ?? d.statusLabel === "BUDGET_EXCEEDED") || undefined,
		model: d.model || undefined,
		inputTokens: d.inputTokens ?? undefined,
		outputTokens: d.outputTokens ?? undefined,
		cacheRead: d.cacheRead ?? undefined,
		cacheWrite: d.cacheWrite ?? undefined,
		cost: d.cost ?? undefined,
		turnCount: d.turnCount ?? undefined,
	};
}
