// ─── Widget presentation cadence ──────────────────────────────────
// 300ms debounce on event-driven flushes + 2s heartbeat to keep the
// terminal rendering during quiet periods. Presentation concern pulled
// out of the orchestrator (separate presentation from logic).

import type { AgentRunState } from "../../config/types.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildWidgetLines } from "../../session/widget.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { getErrorCollector } from "../../pipeline/error-collector.ts";

export interface WidgetFlusher {
	/** Debounced (300ms) event-driven flush. */
	scheduleFlush(): void;
	/** Idempotent — clears timers and suppresses further renders. */
	dispose(): void;
}

export interface WidgetFlusherOptions {
	ctx: ExtensionCommandContext;
	widgetId: string;
	agentName: string;
	model: string;
	state: AgentRunState;
}

export function createWidgetFlusher(opts: WidgetFlusherOptions): WidgetFlusher {
	const log = getDebugLogger();
	let flushTimer: NodeJS.Timeout | null = null;
	let disposed = false;

	const flushWidget = () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (disposed) return;
		try {
			opts.ctx.ui.setWidget(
				opts.widgetId,
				buildWidgetLines(opts.state, opts.agentName, opts.model),
			);
		} catch (renderErr: unknown) {
			const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
			log.error("agent-runner", `Widget render error for ${opts.agentName}: ${msg}`);
			getErrorCollector().push(
				"runner",
				"warn",
				`Widget render error for ${opts.agentName}: ${msg}`,
			);
		}
	};

	const scheduleFlush = () => {
		if (!flushTimer && !disposed) {
			flushTimer = setTimeout(flushWidget, 300);
		}
	};

	// Gentle 2s heartbeat — keeps terminal alive during quiet periods.
	// Original freeze was from requestRender(true) + 5s interval, not the
	// heartbeat itself. Try-catch prevents uncaught exceptions from
	// killing the interval.
	const heartbeatTimer = setInterval(() => {
		try {
			if (!flushTimer && !disposed) flushWidget();
		} catch (hbErr: unknown) {
			const msg = hbErr instanceof Error ? hbErr.message : String(hbErr);
			getErrorCollector().push("runner", "warn", `heartbeat error for ${opts.agentName}: ${msg}`);
		}
	}, 2000);

	return {
		scheduleFlush,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			clearInterval(heartbeatTimer);
		},
	};
}
