// ─── Event normalization + dispatch (formerly event/adapter.ts + event/types.ts) ──
// Converts JSON lines (from pi --mode json subprocess stdout) into
// NormalizedEvent, then dispatches them through the per-kind handlers
// (adapter/handlers.ts). Retained from the refactor — needed by runAgentSubprocess.
//
// Split of the unified event/adapter.ts into adapter/{normalize,handlers,forward}.

import type { AgentRunState } from "../../config/types.ts";
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

// ═══════════════════════════════════════════════════════════════════
// Types (formerly event/types.ts)
// ═══════════════════════════════════════════════════════════════════

export type NormalizedUsage = {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export type NormalizedEvent =
	| { kind: "tool_execution_start"; toolName: string; args?: unknown }
	| { kind: "tool_execution_end"; toolName: string; isError?: boolean }
	| { kind: "thinking_start" }
	| { kind: "thinking_end" }
	| { kind: "thinking_delta"; delta: string }
	| { kind: "text_start" }
	| {
			kind: "text_end";
			usage?: NormalizedUsage;
	  }
	| { kind: "text_delta"; delta: string }
	| {
			kind: "message_end";
			message: {
				role: string;
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				toolName?: string;
				usage?: NormalizedUsage;
			};
	  }
	| {
			kind: "done";
			message: {
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				usage?: NormalizedUsage;
			};
	  }
	| { kind: "context_info"; contextTokens: number; contextWindow: number }
	| { kind: "turn_start" }
	| { kind: "turn_end" }
	| { kind: "agent_start" }
	| { kind: "agent_end" }
	| { kind: "session" };

export interface HandlerResult {
	flush: boolean;
	workingChange: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Adapter (from event/adapter.ts)
// ═══════════════════════════════════════════════════════════════════

type JsonEvent = Record<string, unknown>;

type Extractor = (ev: Record<string, unknown>) => NormalizedEvent | null;

interface KindEntry {
	json: Extractor;
}

const kindTable: Record<string, KindEntry> = {
	session: {
		json: () => ({ kind: "session" }),
	},

	context_info: {
		json: (ev) => ({
			kind: "context_info",
			contextTokens: ev.contextTokens as number,
			contextWindow: ev.contextWindow as number,
		}),
	},

	tool_execution_start: {
		json: (ev) => ({
			kind: "tool_execution_start",
			toolName: (ev.toolName as string) || "tool",
			args: ev.args,
		}),
	},

	tool_execution_end: {
		json: (ev) => ({
			kind: "tool_execution_end",
			toolName: (ev.toolName as string) || "tool",
			isError: !!ev.isError,
		}),
	},

	thinking_start: {
		json: () => ({ kind: "thinking_start" }),
	},

	thinking_delta: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				return { kind: "thinking_delta", delta: (assistantEvent.delta as string) || "" };
			}
			// Legacy: top-level delta wrapper
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "thinking_delta", delta: (delta?.thinking_delta as string) || "" };
		},
	},

	thinking_end: {
		json: () => ({ kind: "thinking_end" }),
	},

	text_start: {
		json: () => ({ kind: "text_start" }),
	},

	text_delta: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				return { kind: "text_delta", delta: (assistantEvent.delta as string) || "" };
			}
			// Legacy: top-level delta wrapper
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "text_delta", delta: (delta?.text_delta as string) || "" };
		},
	},

	text_end: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				// Pi 0.80.2: usage inside assistantMessageEvent.partial.usage
				const partial = assistantEvent.partial as Record<string, unknown> | undefined;
				return { kind: "text_end", usage: (partial?.usage as any) || undefined };
			}
			// Legacy: top-level event
			return { kind: "text_end", usage: ev.usage as any };
		},
	},

	message_end: {
		json: (ev) => ({ kind: "message_end", message: ev.message as any }),
	},

	turn_start: {
		json: () => ({ kind: "turn_start" }),
	},

	turn_end: {
		json: () => ({ kind: "turn_end" }),
	},

	agent_start: {
		json: () => ({ kind: "agent_start" }),
	},

	agent_end: {
		json: () => ({ kind: "agent_end" }),
	},

	done: {
		json: (ev) => {
			if ((ev.type as string) === "message_update") return null;
			return { kind: "done", message: ev.message as any };
		},
	},
};

function resolveJsonKind(ev: JsonEvent): string | null {
	const type = ev.type as string;
	if (!type) return null;
	if (type === "message_update") {
		// Pi 0.80.2: assistantMessageEvent nested field
		const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
		if (assistantEvent) return assistantEvent.type as string;
		// Legacy: delta nested field (pre-0.80.2)
		const delta = ev.delta as Record<string, unknown> | undefined;
		if (delta) return delta.type as string;
		return null;
	}
	return type;
}

export function normalizeEvent(
	source: "json" | "session",
	ev: Record<string, unknown> | null | undefined,
): NormalizedEvent | null {
	if (!ev || typeof ev !== "object") return null;
	if (source !== "json") return null; // session source removed in Phase 3
	const kind = resolveJsonKind(ev);
	if (!kind) return null;
	const entry = kindTable[kind];
	if (!entry) return null;
	return entry.json(ev);
}

// ═══════════════════════════════════════════════════════════════════
// AgentSessionEvent → NormalizedEvent adapter (in-process path)
// ═══════════════════════════════════════════════════════════════════
// Maps SDK AgentSessionEvent union to NormalizedEvent for use with
// processNormalizedEvent. Returns null for unmappable events.

export function agentSessionEventToNormalizedEvent(
	ev: Record<string, unknown> | null | undefined,
): NormalizedEvent | null {
	if (!ev || typeof ev !== "object") return null;

	const type = ev.type as string | undefined;
	if (!type) return null;

	// message_update has nested assistantMessageEvent for deltas
	if (type === "message_update") {
		const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
		if (!assistantEvent) return null;
		const subType = assistantEvent.type as string;
		const delta = assistantEvent.delta as string | undefined;
		const partial = assistantEvent.partial as Record<string, unknown> | undefined;

		switch (subType) {
			case "text_delta":
				return { kind: "text_delta", delta: delta || "" };
			case "thinking_delta":
				return { kind: "thinking_delta", delta: delta || "" };
			case "text_start":
				return { kind: "text_start" };
			case "thinking_start":
				return { kind: "thinking_start" };
			case "text_end":
				return { kind: "text_end", usage: (partial?.usage as any) || undefined };
			case "thinking_end":
				return { kind: "thinking_end" };
			default:
				return null;
		}
	}

	switch (type) {
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
		case "message_end":
			return { kind: "message_end", message: ev.message as any };
		case "thinking_start":
			return { kind: "thinking_start" };
		case "thinking_end":
			return { kind: "thinking_end" };
		case "thinking_delta":
			return { kind: "thinking_delta", delta: (ev.delta as string) || "" };
		case "turn_start":
			return { kind: "turn_start" };
		case "turn_end":
			return { kind: "turn_end" };
		case "agent_start":
			return { kind: "agent_start" };
		case "agent_end":
			return { kind: "agent_end" };
		case "queue_update":
		case "compaction_start":
		case "compaction_end":
			return null;
		default:
			return null;
	}
}

export function jsonLineToNormalizedEvent(line: string): NormalizedEvent | null {
	if (!line.trim()) return null;
	try {
		const ev = JSON.parse(line);
		return normalizeEvent("json", ev);
	} catch {
		return null;
	}
}

export function filterStderr(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith('{"type":"context_info"')) return false;
			if (/^(import\s+|export\s+)/.test(trimmed)) return false;
			if (/^\s+at\s/.test(line)) return false;
			if (!trimmed) return false;
			return true;
		})
		.join("\n")
		.trim();
}

export function processNormalizedEvent(
	ev: NormalizedEvent,
	state: AgentRunState,
	cwd?: string,
): HandlerResult {
	switch (ev.kind) {
		case "tool_execution_start":
			return handleToolExecutionStart(state, ev, cwd);
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
			return { flush: false, workingChange: false };
	}
}
