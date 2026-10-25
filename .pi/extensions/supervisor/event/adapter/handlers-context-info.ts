// --- Context info handler ---------------------------------------
// `context_info` seeds the context-window display. Split out of handlers.ts
// (#2033).

import type { AgentRunState } from "../../config/types.ts";
import { pushLog } from "../../agent/state-helpers.ts";
import type { NormalizedEvent, HandlerResult } from "./normalize.ts";

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
