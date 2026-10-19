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
import type { NormalizedEvent, HandlerResult, JsonEvent } from "./normalize-types.ts";
import { coreKindTable } from "./normalize-table-core.ts";
import { deltaKindTable } from "./normalize-table-deltas.ts";

// ═══════════════════════════════════════════════════════════════════
// Types (formerly event/types.ts) — moved to normalize-types.ts
// ═══════════════════════════════════════════════════════════════════

export type { NormalizedUsage, NormalizedEvent, HandlerResult } from "./normalize-types.ts";

// ═══════════════════════════════════════════════════════════════════
// Adapter (from event/adapter.ts)
// ═══════════════════════════════════════════════════════════════════

const kindTable = { ...coreKindTable, ...deltaKindTable };

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
				parentToolCallId: (ev.parentToolCallId as string) || undefined,
			};
		case "tool_execution_end":
			return {
				kind: "tool_execution_end",
				toolName: (ev.toolName as string) || "tool",
				isError: !!ev.isError,
				parentToolCallId: (ev.parentToolCallId as string) || undefined,
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
