// ─── Shared normalized-event handler ──────────────────────────────
// Owns the normalize → process → workingChange → forward sequence used by
// BOTH the in-process session subscriber and the subprocess line handler.
// Lives in the runner layer (not event/adapter) because it drives run
// presentation; event/adapter stays transform/forward only.
//
// INVARIANT: `preThinkingText` is captured BEFORE processNormalizedEvent,
// which clears state.liveThinking on thinking_end. Both runners route
// through here so a fix to that ordering reaches both paths.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRunState } from "../../config/types.ts";
import {
	forwardNormalizedEventToChat,
	processNormalizedEvent,
	type ForwardChatState,
	type NormalizedEvent,
} from "../../event/adapter.ts";
import { getWorkingMessage } from "../../session/widget.ts";
import type { RunPresenter } from "./presenter.ts";

export interface NormalizedEventHandlerDeps {
	state: AgentRunState;
	effectiveCwd: string;
	agentName: string;
	pi?: Pick<ExtensionAPI, "sendMessage">;
	pending: ForwardChatState;
	/**
	 * Presentation port — only the two members this handler needs. The
	 * subprocess passes its full RunPresenter; the in-process runner owns its
	 * own widget lifecycle and adapts just these two (issue #2106).
	 */
	presenter: Pick<RunPresenter, "scheduleFlush" | "setWorkingMessage">;
}

/**
 * Process one normalized event and keep state + UI + chat in lockstep.
 * No return value: callers own their error handling (each runner keeps its
 * own try/catch and, for the subprocess, the budget-kill tail).
 */
export function handleNormalizedEvent(
	normalized: NormalizedEvent,
	deps: NormalizedEventHandlerDeps,
): void {
	const preThinkingText = normalized.kind === "thinking_end" ? deps.state.liveThinking.trim() : "";

	const result = processNormalizedEvent(normalized, deps.state, deps.effectiveCwd);
	if (result.workingChange) {
		deps.presenter.scheduleFlush();
		const wm = getWorkingMessage(deps.state, deps.agentName);
		deps.presenter.setWorkingMessage(wm ?? undefined);
	}

	// Forward key events as supervisor chat messages
	if (deps.pi) {
		forwardNormalizedEventToChat(
			normalized,
			deps.state,
			deps.pi,
			deps.agentName,
			deps.pending,
			preThinkingText,
			deps.effectiveCwd,
		);
	}
}
