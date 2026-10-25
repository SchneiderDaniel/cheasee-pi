// --- Done event handler -----------------------------------------
// `done` flushes whatever the final message carries: assistant text and
// thinking blocks, plus the usage accounting. Split out of handlers.ts (#2033).

import type { AgentRunState } from "../../config/types.ts";
import { pushTextBlock, pushThinkingBlock } from "../../agent/state-helpers.ts";
import type { NormalizedEvent, HandlerResult } from "./normalize.ts";
import { applyUsage } from "./handlers-text.ts";

export function handleDone(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "done" },
): HandlerResult {
	const msg = ev.message;
	if (msg?.usage) applyUsage(state, msg.usage);

	const content: unknown = msg?.content;

	if (typeof content === "string" && content.trim()) {
		pushTextBlock(state, content);
	} else if (Array.isArray(content)) {
		const textParts: string[] = [];
		const thinkingParts: string[] = [];
		for (const block of content) {
			if (block.type === "text" && block.text) {
				textParts.push(block.text);
			}
			if (block.type === "thinking" && block.thinking) {
				const t =
					typeof block.thinking === "string" ? block.thinking : JSON.stringify(block.thinking);
				thinkingParts.push(t);
			}
		}
		if (textParts.length > 0) {
			const allText = textParts.join("\n").trim();
			if (allText) {
				pushTextBlock(state, allText);
			}
		}
		if (thinkingParts.length > 0) {
			const allThinking = thinkingParts.join("\n").trim();
			if (allThinking) {
				if (!state.thinkingPushedThisTurn) {
					pushThinkingBlock(state, allThinking);
				}
			}
		}
	}

	state.liveText = "";
	state.liveThinking = "";
	state.phase = "idle";
	return { flush: true, workingChange: true };
}
