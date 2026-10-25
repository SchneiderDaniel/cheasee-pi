// --- Text event handlers ----------------------------------------
// `text_start` / `text_delta` / `text_end` to AgentRunState, plus the usage
// accounting they share with `message_end`. Split out of handlers.ts (#2033).

import type { AgentRunState } from "../../config/types.ts";
import { pushLog } from "../../agent/state-helpers.ts";
import type { NormalizedEvent, NormalizedUsage, HandlerResult } from "./normalize.ts";
import { phasePriority } from "./phase.ts";

const MAX_LIVE_THINKING = 500;

const MAX_LIVE_TEXT = 10_000;

const LIVE_TEXT_TRIM = 8_000;

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

export function applyUsage(state: AgentRunState, usage: NormalizedUsage): void {
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
