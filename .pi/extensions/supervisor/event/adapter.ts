// ─── Event Adapters ──────────────────────────────────────────────
// Converts JSON lines (from pi --mode json subprocess stdout) and
// SDK session events (from session.subscribe()) into NormalizedEvent.
// Provides processNormalizedEvent() which delegates to shared handlers.
//
// Also owns: filterStderr() — stderr noise filter for subprocess output.
// Extracted from deleted agent/stream.ts; stderr filtering is an
// external-output transformation that belongs in the adapter layer.

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

// ─── Stderr Filter ────────────────────────────────────────────────

/**
 * Filter known non-error patterns from stderr output.
 * Prevents telemetry noise and jiti diagnostic context from
 * polluting error detection.
 *
 * In --mode json, pi redirects process.stdout.write to stderr
 * (takeOverStdout), so extension console.log calls end up here.
 * Additionally, jiti prints source context lines from the
 * importing file (resource-loader.js) when module resolution
 * fails — these look like "import { ... } from \"...\"" fragments.
 */
export function filterStderr(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			// Skip JSON telemetry events
			if (trimmed.startsWith('{"type":"context_info"')) return false;
			// Skip jiti source-context lines (JS import/export fragments)
			if (/^(import\s+|export\s+)/.test(trimmed)) return false;
			// Skip Node.js stack trace lines
			if (/^\s+at\s/.test(line)) return false;
			// Skip empty lines
			if (!trimmed) return false;
			return true;
		})
		.join("\n")
		.trim();
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
