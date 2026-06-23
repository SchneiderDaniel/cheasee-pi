// ─── Shared Event Handlers ──────────────────────────────────────────
// Standalone pure functions that process NormalizedEvent kinds.
// Each function maps to one NormalizedEvent kind and mutates AgentRunState.
//
// These are the "single source of truth" for event processing logic.
// Both processJsonLine and processSessionEvent delegate to these via
// processNormalizedEvent in event-adapter.ts.

import type { AgentRunState } from "../config/types.ts";
import type { NormalizedEvent, HandlerResult } from "./types.ts";
import { phasePriority } from "./types.ts";
import { pushLog } from "../agent/state-helpers.ts";
import { formatToolCall } from "./session-events.ts";
import { extractTextFromContent } from "../lib/formatting.ts";

// ─── Re-export phasePriority for backward compat ─────────────────

export { phasePriority } from "./types.ts";

// ─── Constants ────────────────────────────────────────────────────

const MAX_FULL_LOG = 500;
const MAX_ARGS_STRING_LEN = 100;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Truncate string values in args before JSON serialization.
 * Prevents invalid JSON from raw .slice() on serialized output.
 */
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

// ─── Handler Functions ────────────────────────────────────────────

export function handleToolExecutionStart(
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

export function handleToolExecutionEnd(
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

export function handleThinkingStart(
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

export function handleThinkingDelta(
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
		// Push complete thinking lines to log immediately
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

export function handleThinkingEnd(
	state: AgentRunState,
	_ev: NormalizedEvent & { kind: "thinking_end" },
): HandlerResult {
	if (state.liveThinking.trim()) {
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

export function handleTextStart(
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

export function handleTextDelta(
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
		// Push complete lines to log immediately
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

export function handleTextEnd(
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

export function handleMessageEnd(
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
			// Capture cache stats
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

	// Budget check: tool call limit
	if (state.maxToolCalls > 0 && state.toolCount >= state.maxToolCalls) {
		state.budgetExceeded = true;
		state.budgetExceededReason = `Tool call limit reached: ${state.toolCount}/${state.maxToolCalls}`;
	}
	// Budget check: token budget
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

export function handleDone(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "done" },
): HandlerResult {
	const msg = ev.message;
	if (msg?.usage) {
		state.tokenCount =
			msg.usage.totalTokens || (msg.usage.input ?? 0) + (msg.usage.output ?? 0) || state.tokenCount;
		// Capture cache stats
		if (typeof msg.usage.cacheRead === "number") state.cacheRead = msg.usage.cacheRead;
		if (typeof msg.usage.cacheWrite === "number") state.cacheWrite = msg.usage.cacheWrite;
	}

	// handleDone: extract content from done event
	// Some models/SDKs (e.g. thinking:high) don't emit text_delta/thinking_delta events.
	// Instead, the entire response is in the done event's message.content as a raw string.
	// Support both array format (blocks) and string format.
	// Use 'as any' because the SDK type defines content as Array but at runtime can be string.
	const content: unknown = msg?.content;

	if (typeof content === "string" && content.trim()) {
		// String content — no block structure, all text
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

export function handleContextInfo(
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
