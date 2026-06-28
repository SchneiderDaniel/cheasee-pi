// ─── Event Adapters + Handlers ──────────────────────────────────────
// Unified file: converts JSON lines (from pi --mode json subprocess stdout)
// into NormalizedEvent, then processes them through shared handlers.
// Retained from the refactor — needed by runAgentSubprocess.
//
// This file consolidates what was previously event/adapter.ts,
// event/handlers.ts, and event/types.ts. After Phase 3 deletion of the
// in-process path, these are the only event-processing functions retained.

import type { AgentRunState, AgentPhase } from "../config/types.ts";
import { pushLog } from "../agent/state-helpers.ts";
import { formatToolCall, extractTextFromContent } from "../lib/formatting.ts";

// ═══════════════════════════════════════════════════════════════════
// Types (formerly event/types.ts)
// ═══════════════════════════════════════════════════════════════════

export type NormalizedEvent =
	| { kind: "tool_execution_start"; toolName: string; args?: unknown }
	| { kind: "tool_execution_end"; toolName: string; isError?: boolean }
	| { kind: "thinking_start" }
	| { kind: "thinking_end" }
	| { kind: "thinking_delta"; delta: string }
	| { kind: "text_start" }
	| {
			kind: "text_end";
			usage?: {
				totalTokens?: number;
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
			};
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
				usage?: {
					totalTokens?: number;
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
				};
			};
	  }
	| {
			kind: "done";
			message: {
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				usage?: {
					totalTokens?: number;
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
				};
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

/** Numeric priority for phase ordering. Higher = more important. */
function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool":
			return 3;
		case "thinking":
			return 2;
		case "text":
			return 1;
		case "idle":
			return 0;
	}
}

// ═══════════════════════════════════════════════════════════════════
// Handlers (formerly event/handlers.ts)
// ═══════════════════════════════════════════════════════════════════

const MAX_FULL_LOG = 500;
const MAX_ARGS_STRING_LEN = 100;

function truncateArgsForDisplay(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (typeof value === "string") {
			result[key] =
				value.length > MAX_ARGS_STRING_LEN ? value.slice(0, MAX_ARGS_STRING_LEN) + "..." : value;
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			result[key] = truncateArgsForDisplay(value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

const MAX_LIVE_THINKING = 500;
const MAX_LIVE_TEXT = 10_000;
const LIVE_TEXT_TRIM = 8_000;

function handleToolExecutionStart(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "tool_execution_start" },
): HandlerResult {
	const prevPhase = state.phase;
	state.currentTool = ev.toolName || "tool";
	state.currentToolArgs = ev.args ? JSON.stringify(truncateArgsForDisplay(ev.args)) : undefined;
	state.lastToolName = ev.toolName;
	state.phase = "tool";
	pushLog(
		state,
		formatToolCall(ev.toolName, ev.args as Record<string, unknown> | null | undefined),
	);
	return { flush: true, workingChange: prevPhase !== "tool" };
}

function handleToolExecutionEnd(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "tool_execution_end" },
): HandlerResult {
	state.toolCount++;
	if (ev.isError) {
		state.failedToolCount = (state.failedToolCount ?? 0) + 1;
	}
	state.currentTool = undefined;
	state.currentToolArgs = undefined;
	state.phase = "idle";
	pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
	return { flush: true, workingChange: true };
}

function handleThinkingStart(
	state: AgentRunState,
	_ev: NormalizedEvent & { kind: "thinking_start" },
): HandlerResult {
	const prevPhase = state.phase;
	if (phasePriority("thinking") >= phasePriority(state.phase)) {
		state.phase = "thinking";
	}
	state.thinkingPushedThisTurn = false;
	return { flush: true, workingChange: prevPhase !== "thinking" };
}

function handleThinkingDelta(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "thinking_delta" },
): HandlerResult {
	const td = ev.delta;
	if (typeof td === "string" && td.length > 0) {
		const prevPhase = state.phase;
		if (phasePriority("thinking") >= phasePriority(state.phase)) {
			state.phase = "thinking";
		}
		state.liveThinking += td;
		if (state.liveThinking.length > MAX_LIVE_THINKING * 2) {
			state.liveThinking = state.liveThinking.slice(-MAX_LIVE_THINKING);
		}
		let nlIdx;
		while ((nlIdx = state.liveThinking.indexOf("\n")) !== -1) {
			const line = state.liveThinking.slice(0, nlIdx);
			state.liveThinking = state.liveThinking.slice(nlIdx + 1);
			if (line.trim()) {
				pushLog(state, `💭 ${line}`);
				state.thinkingPushedThisTurn = true;
			}
		}
		return { flush: true, workingChange: prevPhase !== "thinking" };
	}
	return { flush: false, workingChange: false };
}

function handleThinkingEnd(
	state: AgentRunState,
	_ev: NormalizedEvent & { kind: "thinking_end" },
): HandlerResult {
	if (state.liveThinking.trim()) {
		state.thinkingOutputLines.push(state.liveThinking.trim());
		for (const t of state.liveThinking.split("\n")) {
			const trimmed = t.trim();
			if (trimmed) pushLog(state, `💭 ${trimmed.slice(0, 500)}`);
		}
		state.thinkingPushedThisTurn = true;
	}
	state.liveThinking = "";
	state.phase = "idle";
	return { flush: true, workingChange: true };
}

function handleTextStart(
	state: AgentRunState,
	_ev: NormalizedEvent & { kind: "text_start" },
): HandlerResult {
	const prevPhase = state.phase;
	if (phasePriority("text") >= phasePriority(state.phase)) {
		state.phase = "text";
	}
	state.textPushedThisTurn = false;
	return { flush: true, workingChange: prevPhase !== "text" };
}

function handleTextDelta(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "text_delta" },
): HandlerResult {
	const td = ev.delta;
	if (typeof td === "string" && td.length > 0) {
		const prevPhase = state.phase;
		if (phasePriority("text") >= phasePriority(state.phase)) {
			state.phase = "text";
		}
		state.liveText += td;
		if (state.liveText.length > MAX_LIVE_TEXT) {
			state.liveText = state.liveText.slice(-LIVE_TEXT_TRIM);
		}
		let nlIdx;
		while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
			const line = state.liveText.slice(0, nlIdx);
			state.liveText = state.liveText.slice(nlIdx + 1);
			if (line.trim()) {
				pushLog(state, line);
				state.textPushedThisTurn = true;
			}
		}
		return { flush: true, workingChange: prevPhase !== "text" };
	}
	return { flush: false, workingChange: false };
}

function handleTextEnd(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "text_end" },
): HandlerResult {
	if (state.liveText.trim()) {
		state.textOutputLines.push(state.liveText.trim());
		for (const t of state.liveText.split("\n")) {
			const trimmed = t.trim();
			if (trimmed) pushLog(state, trimmed);
		}
		state.textPushedThisTurn = true;
	}
	if (ev.usage) {
		state.tokenCount =
			ev.usage.totalTokens || (ev.usage.input ?? 0) + (ev.usage.output ?? 0) || state.tokenCount;
	}
	state.liveText = "";
	state.phase = "idle";
	return { flush: true, workingChange: true };
}

function handleMessageEnd(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "message_end" },
): HandlerResult {
	const msg = ev.message;
	if (!msg) return { flush: false, workingChange: false };

	if (msg.role === "assistant") {
		if (Array.isArray(msg.content) && !state.thinkingPushedThisTurn) {
			const thinkingParts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking" && block.thinking) {
					const thinkingText =
						typeof block.thinking === "string"
							? block.thinking
							: JSON.stringify(block.thinking).slice(0, 500);
					thinkingParts.push(thinkingText);
					for (const t of thinkingText.split("\n")) {
						if (t.trim()) pushLog(state, `💭 ${t.slice(0, 500)}`);
					}
				}
			}
			if (thinkingParts.length > 0) {
				state.thinkingOutputLines.push(thinkingParts.join("\n").trim());
				state.thinkingPushedThisTurn = true;
			}
		}
		if (!state.textPushedThisTurn) {
			const text = extractTextFromContent(msg.content);
			if (text && text.trim()) {
				state.textOutputLines.push(text.trim());
				state.textPushedThisTurn = true;
				for (const t of text.split("\n")) {
					if (t.trim()) pushLog(state, t);
				}
			}
		}
		if (msg.usage) {
			state.tokenCount =
				msg.usage.totalTokens ||
				(msg.usage.input ?? 0) + (msg.usage.output ?? 0) ||
				state.tokenCount;
			if (typeof msg.usage.cacheRead === "number") state.cacheRead = msg.usage.cacheRead;
			if (typeof msg.usage.cacheWrite === "number") state.cacheWrite = msg.usage.cacheWrite;
		}
	} else if (msg.role === "toolResult") {
		const resultText = extractTextFromContent(msg.content);
		const label = msg.toolName || state.lastToolName || "tool";
		if (resultText && resultText.trim()) {
			const resultLines = resultText.split("\n");
			pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
			for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
				if (resultLines[i].trim()) pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
			}
		} else {
			pushLog(state, `📋 ${label}: (no output)`);
		}
		state.lastToolName = undefined;
	}

	if (state.maxToolCalls > 0 && state.toolCount >= state.maxToolCalls) {
		state.budgetExceeded = true;
		state.budgetExceededReason = `Tool call limit reached: ${state.toolCount}/${state.maxToolCalls}`;
	}
	if (state.agentTokenBudget > 0 && state.tokenCount >= state.agentTokenBudget) {
		state.budgetExceeded = true;
		const reason = `Token budget exceeded: ${state.tokenCount}/${state.agentTokenBudget}`;
		state.budgetExceededReason = state.budgetExceededReason
			? `${state.budgetExceededReason}; ${reason}`
			: reason;
	}

	state.phase = "idle";
	return { flush: true, workingChange: true };
}

function handleDone(state: AgentRunState, ev: NormalizedEvent & { kind: "done" }): HandlerResult {
	const msg = ev.message;
	if (msg?.usage) {
		state.tokenCount =
			msg.usage.totalTokens || (msg.usage.input ?? 0) + (msg.usage.output ?? 0) || state.tokenCount;
		if (typeof msg.usage.cacheRead === "number") state.cacheRead = msg.usage.cacheRead;
		if (typeof msg.usage.cacheWrite === "number") state.cacheWrite = msg.usage.cacheWrite;
	}

	const content: unknown = msg?.content;

	if (typeof content === "string" && content.trim()) {
		if (!state.textPushedThisTurn) {
			state.textOutputLines.push(content.trim());
			state.textPushedThisTurn = true;
			for (const t of content.split("\n")) {
				if (t.trim()) pushLog(state, t);
			}
		}
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
		if (!state.textPushedThisTurn && textParts.length > 0) {
			const allText = textParts.join("\n").trim();
			if (allText) {
				state.textOutputLines.push(allText);
				state.textPushedThisTurn = true;
				for (const t of allText.split("\n")) {
					if (t.trim()) pushLog(state, t);
				}
			}
		}
		if (thinkingParts.length > 0 && !state.thinkingPushedThisTurn) {
			const allThinking = thinkingParts.join("\n").trim();
			if (allThinking) {
				state.thinkingOutputLines.push(allThinking);
				state.thinkingPushedThisTurn = true;
				for (const t of allThinking.split("\n")) {
					if (t.trim()) pushLog(state, `💭 ${t}`);
				}
			}
		}
	}

	state.liveText = "";
	state.liveThinking = "";
	state.phase = "idle";
	return { flush: true, workingChange: true };
}

function handleContextInfo(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "context_info" },
): HandlerResult {
	const tokens = ev.contextTokens;
	const window = ev.contextWindow;
	if (typeof tokens === "number" && typeof window === "number" && window > 0) {
		state.contextTokens = tokens;
		state.contextWindow = window;
		state.contextInfoReceived = true;
		pushLog(
			state,
			`📊 Context: ${(tokens / 1000).toFixed(1)}K/${(window / 1000).toFixed(1)}K (initial)`,
		);
		return { flush: true, workingChange: false };
	}
	return { flush: false, workingChange: false };
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
			return { flush: false, workingChange: false };
	}
}
