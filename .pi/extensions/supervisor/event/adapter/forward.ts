// ─── Chat message forwarding (formerly part of event/adapter.ts) ──
// Forward a normalized event to the supervisor chat as a user-visible
// message. Humble presenter: no state mutation, no business decisions.
// Called during event processing in both in-process and subprocess runners.
//
// Split of the unified event/adapter.ts into adapter/{normalize,handlers,forward}.

import type { AgentRunState } from "../../config/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderToolCallText } from "../../lib/render-helpers.ts";
import { extractTextFromContent } from "../../lib/formatting.ts";
import type { NormalizedEvent } from "./normalize.ts";

// ═══════════════════════════════════════════════════════════════════
// Chat message forwarding (shared by in-process and subprocess runners)
// ═══════════════════════════════════════════════════════════════════

/** Mutable accumulator state for chat forwarding */
export interface ForwardChatState {
	toolSeqNum: number;
	pendingToolName: string;
	pendingToolFormattedArgs: string;
	pendingToolStartTime: number;
	pendingToolIsError: boolean;
}

/** Create initial ForwardChatState */
export function createForwardChatState(): ForwardChatState {
	return {
		toolSeqNum: 0,
		pendingToolName: "",
		pendingToolFormattedArgs: "",
		pendingToolStartTime: 0,
		pendingToolIsError: false,
	};
}

/**
 * Forward a normalized event to the supervisor chat as a user-visible message.
 * Called during event processing in both in-process and subprocess runners.
 * Keeps chat rendering in sync with agent progress.
 *
 * This is the shared implementation — both runners call it instead of
 * duplicating the switch logic. Subprocess adds child.kill("SIGTERM")
 * for budget exceed outside this function.
 */
export function forwardNormalizedEventToChat(
	normalized: NormalizedEvent,
	state: AgentRunState,
	pi: Pick<ExtensionAPI, "sendMessage">,
	agentName: string,
	pending: ForwardChatState,
	preThinkingText?: string,
	cwd?: string,
): void {
	switch (normalized.kind) {
		case "tool_execution_start": {
			pending.toolSeqNum++;
			pending.pendingToolName = normalized.toolName;
			pending.pendingToolStartTime = Date.now();
			pending.pendingToolIsError = false;
			const formatted = renderToolCallText(
				normalized.toolName,
				normalized.args,
				cwd ?? process.cwd(),
			);
			pending.pendingToolFormattedArgs = formatted;
			pi.sendMessage({
				customType: "supervisor",
				content: `⏳ ${agentName} — ${formatted}`,
				display: true,
				details: {
					eventType: "tool-start",
					agentName,
					toolName: normalized.toolName,
					args: formatted,
				},
			});
			break;
		}
		case "tool_execution_end": {
			pending.pendingToolIsError = !!normalized.isError;
			break;
		}
		case "message_end": {
			const msg = normalized.message;
			if (msg?.role === "toolResult") {
				const toolName = pending.pendingToolName || msg.toolName || "tool";
				const resultText = extractTextFromContent(msg.content);
				const durationMs =
					pending.pendingToolStartTime > 0 ? Date.now() - pending.pendingToolStartTime : 0;
				pi.sendMessage({
					customType: "supervisor",
					content: `${toolName}`,
					display: true,
					details: {
						eventType: "tool-complete",
						agentName,
						toolName,
						args: pending.pendingToolFormattedArgs,
						isError: pending.pendingToolIsError,
						resultText: resultText.slice(0, 2000),
						toolIndex: `#${pending.toolSeqNum}`,
						toolDurationMs: durationMs,
						runningTokenCount: state.tokenCount,
						runningToolCount: state.toolCount,
						errorCount: state.failedToolCount ?? 0,
						maxToolCalls: state.maxToolCalls,
						agentTokenBudget: state.agentTokenBudget,
					},
				});
				pending.pendingToolName = "";
				pending.pendingToolFormattedArgs = "";
				pending.pendingToolStartTime = 0;
				pending.pendingToolIsError = false;
			}
			break;
		}
		case "thinking_end": {
			if (preThinkingText) {
				pi.sendMessage({
					customType: "supervisor",
					content: `💭 ${agentName}`,
					display: true,
					details: {
						eventType: "thinking",
						content: preThinkingText,
						agentName,
					},
				});
			}
			break;
		}
	}
}
