// ─── Event handlers (formerly event/handlers.ts) ──
// Per-kind AgentRunState mutation for normalized events. Pure state
// transforms over shared AgentRunState — no I/O, no chat rendering
// (that lives in adapter/forward.ts).
//
// Split of the unified event/adapter.ts into adapter/{normalize,handlers,forward}.

import type { AgentRunState, AgentPhase } from "../../config/types.ts";
import { pushLog, pushTextBlock, pushThinkingBlock } from "../../agent/state-helpers.ts";
import { renderToolCallText } from "../../lib/render-helpers.ts";
import { extractTextFromContent } from "../../lib/formatting.ts";
import type { NormalizedEvent, NormalizedUsage, HandlerResult } from "./normalize.ts";

// ═══════════════════════════════════════════════════════════════════
// Handlers (formerly event/handlers.ts)
// ═══════════════════════════════════════════════════════════════════

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

export function handleToolExecutionStart(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "tool_execution_start" },
	cwd?: string,
): HandlerResult {
	const prevPhase = state.phase;
	state.currentTool = ev.toolName || "tool";
	state.currentToolArgs = ev.args ? JSON.stringify(truncateArgsForDisplay(ev.args)) : undefined;
	state.lastToolName = ev.toolName;
	// Track tool name in session state for tool-call line filtering
	if (ev.toolName && !state.toolCalls.includes(ev.toolName)) {
		state.toolCalls.push(ev.toolName);
	}
	state.phase = "tool";
	pushLog(state, renderToolCallText(ev.toolName, ev.args, cwd ?? process.cwd()));
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
		let nlIdx;
		while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
			const line = state.liveText.slice(0, nlIdx);
			state.liveText = state.liveText.slice(nlIdx + 1);
			if (line.trim()) {
				pushLog(state, line);
				state.textOutputLines.push(line);
				state.textPushedThisTurn = true;
			}
		}
		return { flush: true, workingChange: prevPhase !== "text" };
	}
	return { flush: false, workingChange: false };
}

function applyUsage(state: AgentRunState, usage: NormalizedUsage): void {
	state.tokenCount =
		usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) || state.tokenCount;
	if (typeof usage.cacheRead === "number") state.cacheRead = usage.cacheRead;
	if (typeof usage.cacheWrite === "number") state.cacheWrite = usage.cacheWrite;
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
	if (ev.usage) applyUsage(state, ev.usage);
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
