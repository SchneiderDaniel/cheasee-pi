// ─── Event Adapters ──────────────────────────────────────────────
// Converts JSON lines (from pi --mode json subprocess stdout) and
// SDK session events (from session.subscribe()) into NormalizedEvent.
// Provides processNormalizedEvent() which delegates to shared handlers.

import type { AgentRunState } from "../config/types.ts";
import type { NormalizedEvent, HandlerResult } from "./types.ts";
import {
	handleToolExecutionStart,
	handleToolExecutionEnd,
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingEnd,
	handleTextStart,
	handleTextDelta,
	handleTextEnd,
	handleMessageEnd,
	handleDone,
	handleContextInfo,
} from "./handlers.ts";

// ─── JSON Line → NormalizedEvent ─────────────────────────────────

/**
 * Convert a JSON line from pi --mode json stdout to a NormalizedEvent.
 * Returns null if the line is empty, invalid JSON, or an unrecognized event type.
 */
export function jsonLineToNormalizedEvent(line: string): NormalizedEvent | null {
	if (!line.trim()) return null;
	try {
		const ev = JSON.parse(line);
		switch (ev.type) {
			case "session":
				return { kind: "session" };

			case "context_info":
				return {
					kind: "context_info",
					contextTokens: ev.contextTokens,
					contextWindow: ev.contextWindow,
				};

			case "tool_execution_start":
				return { kind: "tool_execution_start", toolName: ev.toolName || "tool", args: ev.args };

			case "tool_execution_end":
				return {
					kind: "tool_execution_end",
					toolName: ev.toolName || "tool",
					isError: !!ev.isError,
				};

			case "message_update": {
				const delta = ev.delta;
				if (!delta) return null;
				switch (delta.type) {
					case "thinking_start":
						return { kind: "thinking_start" };
					case "thinking_delta":
						return { kind: "thinking_delta", delta: delta.thinking_delta || "" };
					case "thinking_end":
						return { kind: "thinking_end" };
					case "text_start":
						return { kind: "text_start" };
					case "text_delta":
						return { kind: "text_delta", delta: delta.text_delta || "" };
					case "text_end":
						return { kind: "text_end", usage: ev.usage };
					default:
						return null;
				}
			}

			case "message_end":
				return { kind: "message_end", message: ev.message };

			case "turn_start":
				return { kind: "turn_start" };
			case "turn_end":
				return { kind: "turn_end" };
			case "agent_start":
				return { kind: "agent_start" };
			case "agent_end":
				return { kind: "agent_end" };

			case "done":
				return { kind: "done", message: ev.message };

			default:
				return null;
		}
	} catch {
		return null;
	}
}

// ─── Session Event → NormalizedEvent ─────────────────────────────

/**
 * Convert an SDK session event to a NormalizedEvent.
 * Returns null for unrecognized event types or events that should be skipped.
 */
export function sessionEventToNormalizedEvent(ev: Record<string, unknown>): NormalizedEvent | null {
	if (!ev || !ev.type) return null;
	const type = ev.type as string;

	switch (type) {
		case "context_info":
			// context_info event removed in new agent-core — skip
			return null;

		case "tool_execution_start":
			return {
				kind: "tool_execution_start",
				toolName: (ev.toolName as string) || "tool",
				args: ev.args,
			};

		case "tool_execution_end":
			return {
				kind: "tool_execution_end",
				toolName: (ev.toolName as string) || "tool",
				isError: !!ev.isError,
			};

		case "message_update": {
			const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (!ae) return null;
			const aeType = ae.type as string;
			switch (aeType) {
				case "thinking_start":
					return { kind: "thinking_start" };
				case "thinking_delta":
					return { kind: "thinking_delta", delta: (ae.delta as string) || "" };
				case "thinking_end":
					return { kind: "thinking_end" };
				case "text_start":
					return { kind: "text_start" };
				case "text_delta":
					return { kind: "text_delta", delta: (ae.delta as string) || "" };
				case "text_end": {
					const msg = ev.message as Record<string, unknown> | undefined;
					return { kind: "text_end", usage: msg?.usage as any };
				}
				case "done": {
					return {
						kind: "done",
						// assistantMessageEvent carries the message content, not ev.message
						message: (ae.message || ev.message) as any,
					};
				}
				default:
					return null;
			}
		}

		case "message_end":
			return { kind: "message_end", message: ev.message as any };

		case "turn_start":
			return { kind: "turn_start" };
		case "turn_end":
			return { kind: "turn_end" };
		case "agent_start":
			return { kind: "agent_start" };
		case "agent_end":
			return { kind: "agent_end" };
		case "session":
			return { kind: "session" };

		case "done":
			return { kind: "done", message: ev.message as any };

		default:
			return null;
	}
}

// ─── processNormalizedEvent — single dispatch point ───────────────

/**
 * Process a NormalizedEvent by dispatching to the appropriate handler.
 * This is the single unified event processor — both processJsonLine and
 * processSessionEvent delegate to this function.
 *
 * Mutates state in place. Returns flush + workingChange flags.
 */
export function processNormalizedEvent(ev: NormalizedEvent, state: AgentRunState): HandlerResult {
	switch (ev.kind) {
		case "tool_execution_start":
			return handleToolExecutionStart(state, ev);

		case "tool_execution_end":
			return handleToolExecutionEnd(state, ev);

		case "thinking_start":
			return handleThinkingStart(state, ev);

		case "thinking_delta":
			return handleThinkingDelta(state, ev);

		case "thinking_end":
			return handleThinkingEnd(state, ev);

		case "text_start":
			return handleTextStart(state, ev);

		case "text_delta":
			return handleTextDelta(state, ev);

		case "text_end":
			return handleTextEnd(state, ev);

		case "message_end":
			return handleMessageEnd(state, ev);

		case "done":
			return handleDone(state, ev);

		case "context_info":
			return handleContextInfo(state, ev);

		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_end":
		case "session":
			// No-op events — handled by returning flush=false
			return { flush: false, workingChange: false };
	}
}
