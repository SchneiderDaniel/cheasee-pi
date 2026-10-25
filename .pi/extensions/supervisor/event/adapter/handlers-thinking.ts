// --- Thinking event handlers ------------------------------------
// `thinking_start` / `thinking_delta` / `thinking_end` to AgentRunState.
// Split out of handlers.ts (issue #2033).

import type { AgentRunState } from "../../config/types.ts";
import { pushLog } from "../../agent/state-helpers.ts";
import type { NormalizedEvent, HandlerResult } from "./normalize.ts";
import { phasePriority } from "./phase.ts";

const MAX_LIVE_THINKING = 500;

const MAX_LIVE_TEXT = 10_000;

const LIVE_TEXT_TRIM = 8_000;

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
