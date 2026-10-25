// ─── Message end handler ────────────────────────────────────────
// `message_end` is the transcript-completion event: it flushes the final
// assistant blocks (or the tool result) into the run log and re-checks the
// budgets. Split out of handlers.ts (issue #2033).

import type { AgentRunState } from "../../config/types.ts";
import { pushLog, pushTextBlock, pushThinkingBlock } from "../../agent/state-helpers.ts";
import { extractTextFromContent } from "../../lib/formatting.ts";
import type { NormalizedEvent, HandlerResult } from "./normalize.ts";
import { applyUsage } from "./handlers-text.ts";
import { applyBudgets } from "./handlers-budget.ts";

type MessageEndEvent = NormalizedEvent & { kind: "message_end" };

/** Flush the assistant turn's thinking + text blocks. */
function pushAssistantMessage(state: AgentRunState, msg: MessageEndEvent["message"]): void {
	if (Array.isArray(msg.content)) {
		const thinkingParts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "thinking" && block.thinking) {
				const thinkingText =
					typeof block.thinking === "string"
						? block.thinking
						: JSON.stringify(block.thinking).slice(0, 500);
				thinkingParts.push(thinkingText);
			}
		}
		if (thinkingParts.length > 0) {
			if (!state.thinkingPushedThisTurn) {
				pushThinkingBlock(state, thinkingParts.join("\n"));
			}
		}
	}
	const text = extractTextFromContent(msg.content);
	if (text && text.trim()) {
		pushTextBlock(state, text);
	}
	if (msg.usage) applyUsage(state, msg.usage);
}

/** Log the first lines of a tool result under its 📋 marker. */
function pushToolResultMessage(state: AgentRunState, msg: MessageEndEvent["message"]): void {
	const resultText = extractTextFromContent(msg.content);
	const label = msg.toolName || state.lastToolName || "tool";
	if (resultText && resultText.trim()) {
		const resultLines = resultText.split("\n");
		pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
		for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
			if (resultLines[i]!.trim()) pushLog(state, `   ${resultLines[i]!.slice(0, 200)}`);
		}
	} else {
		pushLog(state, `📋 ${label}: (no output)`);
	}
	state.lastToolName = undefined;
}

export function handleMessageEnd(state: AgentRunState, ev: MessageEndEvent): HandlerResult {
	const msg = ev.message;
	if (!msg) return { flush: false, workingChange: false };

	if (msg.role === "assistant") {
		pushAssistantMessage(state, msg);
	} else if (msg.role === "toolResult") {
		pushToolResultMessage(state, msg);
	}

	applyBudgets(state);

	state.phase = "idle";
	return { flush: true, workingChange: true };
}
