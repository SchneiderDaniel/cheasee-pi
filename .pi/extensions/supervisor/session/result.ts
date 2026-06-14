// ─── Session Result Assembly ──────────────────────────────────────
// Build AgentRunResult from session state and message history.
// Extracted from agent-session-runner.ts to keep files modular.

import type { AgentRunState, AgentRunResult } from "../config/types.ts";
import { extractTextFromContent, extractSummaryLine } from "../lib/formatting.ts";

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
	if (Array.isArray(messages) && messages.length > 0) {
		const lastAsstMsg = [...messages].reverse().find((m) => m && m.role === "assistant" && m.usage);
		if (lastAsstMsg?.usage) {
			const u = lastAsstMsg.usage;
			const lastTotal = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
			if (typeof lastTotal === "number" && !Number.isNaN(lastTotal) && lastTotal > 0) {
				tokenCount = Math.max(state.tokenCount, lastTotal);
			}
		}
	}

	return {
		output: rawOutput,
		success,
		agentName,
		toolCount: state.toolCount,
		tokenCount: tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput: "",
		thinkingOutput,
		budgetExceeded: state.budgetExceeded || undefined,
	};
}
