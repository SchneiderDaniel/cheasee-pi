// ─── Event Adapters ──────────────────────────────────────────────
// Converts JSON lines (from pi --mode json subprocess stdout) and
// SDK session events (from session.subscribe()) into NormalizedEvent.
// Provides processNormalizedEvent() which delegates to shared handlers.
//
// Also owns: filterStderr() — stderr noise filter for subprocess output.
// Extracted from deleted agent/stream.ts; stderr filtering is an
// external-output transformation that belongs in the adapter layer.
//
// ─── Table-driven normalizer ────────────────────────────────────
// Replaces the former parallel-switch design (jsonLineToNormalizedEvent
// vs sessionEventToNormalizedEvent) with a single kind-to-extractor
// table. Each NormalizedEvent kind has one entry with per-source field
// accessors. A single dispatcher consumes the table.
//   ℹ️  jsonLineToNormalizedEvent and sessionEventToNormalizedEvent are
//      kept as thin wrappers for backward compatibility.

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

// ─── Types ──────────────────────────────────────────────────────

type JsonEvent = Record<string, unknown>;
type SessionEvent = Record<string, unknown>;

type Extractor = (ev: Record<string, unknown>) => NormalizedEvent | null;

interface KindEntry {
	json: Extractor;
	session: Extractor;
}

// ─── Kind-to-extractor table ──────────────────────────────────
// Each NormalizedEvent kind has one entry; both source extractors
// are registered at the same site. Adding a new event kind means
// adding one entry here and one variant to the NormalizedEvent union.
//
// Per-source extractor strategy (from Research Findings):
//   - JSON source: typed property access on parsed JSON object
//   - Session source: cast-based access on Record<string, unknown>

const kindTable: Record<string, KindEntry> = {
	session: {
		json: () => ({ kind: "session" }),
		session: () => ({ kind: "session" }),
	},

	context_info: {
		json: (ev) => ({
			kind: "context_info",
			contextTokens: ev.contextTokens as number,
			contextWindow: ev.contextWindow as number,
		}),
		// context_info removed in new agent-core — skip
		session: () => null,
	},

	tool_execution_start: {
		json: (ev) => ({
			kind: "tool_execution_start",
			toolName: (ev.toolName as string) || "tool",
			args: ev.args,
		}),
		session: (ev) => ({
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
		session: (ev) => ({
			kind: "tool_execution_end",
			toolName: (ev.toolName as string) || "tool",
			isError: !!ev.isError,
		}),
	},

	thinking_start: {
		// Sub-event: no extra fields
		json: () => ({ kind: "thinking_start" }),
		session: () => ({ kind: "thinking_start" }),
	},

	thinking_delta: {
		// JSON: ev.delta.thinking_delta ; Session: ev.assistantMessageEvent.delta
		json: (ev) => {
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "thinking_delta", delta: (delta?.thinking_delta as string) || "" };
		},
		session: (ev) => {
			const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			return { kind: "thinking_delta", delta: (ae?.delta as string) || "" };
		},
	},

	thinking_end: {
		json: () => ({ kind: "thinking_end" }),
		session: () => ({ kind: "thinking_end" }),
	},

	text_start: {
		json: () => ({ kind: "text_start" }),
		session: () => ({ kind: "text_start" }),
	},

	text_delta: {
		// JSON: ev.delta.text_delta ; Session: ev.assistantMessageEvent.delta
		json: (ev) => {
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "text_delta", delta: (delta?.text_delta as string) || "" };
		},
		session: (ev) => {
			const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			return { kind: "text_delta", delta: (ae?.delta as string) || "" };
		},
	},

	text_end: {
		// JSON: ev.usage ; Session: ev.message.usage
		json: (ev) => ({ kind: "text_end", usage: ev.usage as any }),
		session: (ev) => {
			const msg = ev.message as Record<string, unknown> | undefined;
			return { kind: "text_end", usage: msg?.usage as any };
		},
	},

	message_end: {
		json: (ev) => ({ kind: "message_end", message: ev.message as any }),
		session: (ev) => ({ kind: "message_end", message: ev.message as any }),
	},

	turn_start: {
		json: () => ({ kind: "turn_start" }),
		session: () => ({ kind: "turn_start" }),
	},

	turn_end: {
		json: () => ({ kind: "turn_end" }),
		session: () => ({ kind: "turn_end" }),
	},

	agent_start: {
		json: () => ({ kind: "agent_start" }),
		session: () => ({ kind: "agent_start" }),
	},

	agent_end: {
		json: () => ({ kind: "agent_end" }),
		session: () => ({ kind: "agent_end" }),
	},

	done: {
		// JSON source only emits done at top level (ev.type === "done"),
		// not as a message_update sub-event.
		// Session source emits done both at top level and as a
		// message_update sub-event (reads ae.message || ev.message).
		json: (ev) => {
			if ((ev.type as string) === "message_update") return null;
			return { kind: "done", message: ev.message as any };
		},
		session: (ev) => {
			const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			return { kind: "done", message: (ae?.message || ev.message) as any };
		},
	},
};

// ─── Kind resolution per source ─────────────────────────────────
// Each source has its own strategy for determining the kind from a
// raw event object. For the JSON source, message_update sub-events
// live under ev.delta; for the session source they live under
// ev.assistantMessageEvent.

function resolveJsonKind(ev: JsonEvent): string | null {
	const type = ev.type as string;
	if (!type) return null;
	// Two-level dispatch: message_update reads delta.type
	if (type === "message_update") {
		const delta = ev.delta as Record<string, unknown> | undefined;
		if (!delta) return null;
		return delta.type as string;
	}
	return type;
}

function resolveSessionKind(ev: SessionEvent): string | null {
	const type = ev.type as string;
	if (!type) return null;
	// Two-level dispatch: message_update reads assistantMessageEvent.type
	if (type === "message_update") {
		const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
		if (!ae) return null;
		return ae.type as string;
	}
	return type;
}

// ─── Single dispatcher ──────────────────────────────────────────

/**
 * Convert a raw event object to a NormalizedEvent using the
 * kind-to-extractor table.
 *
 * @param source - Event source: "json" (parsed JSON line) or "session" (SDK event)
 * @param ev - Raw event object (may be null/undefined)
 * @returns The matching NormalizedEvent, or null if the event is
 *          unrecognised or the source returns null for this kind.
 *
 * WARNING: Returns null for unregistered kinds — no error is thrown.
 * The registration guard test (see event-adapter.test.mts) ensures
 * every NormalizedEvent variant has a table entry at test time.
 */
export function normalizeEvent(
	source: "json" | "session",
	ev: Record<string, unknown> | null | undefined,
): NormalizedEvent | null {
	if (!ev || typeof ev !== "object") return null;
	const kind = source === "json" ? resolveJsonKind(ev) : resolveSessionKind(ev);
	if (!kind) return null;
	const entry = kindTable[kind];
	if (!entry) return null;
	return entry[source](ev);
}

// ─── JSON Line → NormalizedEvent (wrapper) ──────────────────────

/**
 * Convert a JSON line from pi --mode json stdout to a NormalizedEvent.
 * Thin wrapper around normalizeEvent("json", …) that handles JSON parsing.
 * Returns null if the line is empty, invalid JSON, or an unrecognized event type.
 */
export function jsonLineToNormalizedEvent(line: string): NormalizedEvent | null {
	if (!line.trim()) return null;
	try {
		const ev = JSON.parse(line);
		return normalizeEvent("json", ev);
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

// ─── Session Event → NormalizedEvent (wrapper) ─────────────────────

/**
 * Convert an SDK session event to a NormalizedEvent.
 * Thin wrapper around normalizeEvent("session", …).
 * Returns null for unrecognized event types or events that should be skipped.
 */
export function sessionEventToNormalizedEvent(ev: Record<string, unknown>): NormalizedEvent | null {
	return normalizeEvent("session", ev);
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
