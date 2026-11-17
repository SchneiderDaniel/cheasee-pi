// ── pi event → footer state ─────────────────────────────────────
// Every live update the footer reacts to, in one place. The handlers own no
// state of their own: they read the current FooterState through `getState`
// (undefined before session_start, undefined again after shutdown) and do
// nothing once it is missing or disposed.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FooterState } from "./footer-state.ts";
import { mirrorThinkingLevel } from "./lib/thinking-level.ts";
import { applyCacheStats, applyIssueDataEvent, applyTpsSample } from "./events-data.ts";
import { registerWidgetClearance } from "./events-widgets.ts";
import { ISSUE_DATA_EVENT, parseIssueDataEvent } from "../lib/issue-data-event.ts";

/** Current footer state, or undefined before session_start / after shutdown. */
export type GetState = () => FooterState | undefined;

/**
 * The footer state a handler may write to — undefined before session_start,
 * after shutdown, and once disposed. Every listener starts here, so they all
 * agree on what "no state" means.
 */
function liveState(getState: GetState): FooterState | undefined {
	const state = getState();
	if (!state) return undefined;
	if (state.disposed) return undefined;
	return state;
}

export function registerFooterEvents(pi: ExtensionAPI, getState: GetState): void {
	// ── Cross-extension event listener (shared pi.events) ──────────
	// Topic, payload shape come from the neutral contract module both sides
	// import. `parseIssueDataEvent` turns the bus's `unknown` into the typed
	// payload, so a foreign emitter can never corrupt the footer.
	pi.events.on(ISSUE_DATA_EVENT, (raw: unknown) => {
		const state = liveState(getState);
		if (!state) return;
		applyIssueDataEvent(state, parseIssueDataEvent(raw));
	});

	// ── Widget clearing on user interaction ────────────────────────
	registerWidgetClearance(pi);

	// ── Footer state updates ───────────────────────────────────────
	pi.on("thinking_level_select", async (event, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		state.footerConfig.thinkingLevel = event.level;
		if (state.config) {
			state.callInstallFooter();
		}
	});

	pi.on("model_select", async (event, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			state.footerConfig.lastContextWindow.value = cw;
		}
		// Reset cache stats on model change (cache keys are provider/model-specific).
		// Counts follow the rate: they describe the previous model's records.
		state.resetCacheStats();
		// Session name can change mid-session (setSessionName)
		state.footerConfig.sessionName = pi.getSessionName();
		// Model switch re-clamps the thinking level — resync the mirror
		state.footerConfig.thinkingLevel = mirrorThinkingLevel(pi);
		if (state.config) {
			state.callInstallFooter();
		}
	});

	pi.on("turn_end", async (_event, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		if (!state.config) return;
		// Session name can change mid-session (setSessionName)
		state.footerConfig.sessionName = pi.getSessionName();
		state.callInstallFooter();
	});

	pi.on("message_end", async (event, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		applyCacheStats(state, msg.usage);
	});

	pi.on("message_start", async (event, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		// A new assistant message starts a new streaming window. The role check
		// keeps user/tool messages from wiping an in-flight estimate.
		state.beginResponse();
	});

	pi.on("message_update", async (event: any, _ctx: ExtensionContext) => {
		const state = liveState(getState);
		if (!state) return;
		// Sample the streamed content for TPS estimation
		applyTpsSample(state, event);
	});

	pi.on("tool_execution_end", async () => {
		const state = liveState(getState);
		if (!state) return;
		state.addToolCall();
	});
}
