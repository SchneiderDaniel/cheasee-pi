// ─── Run presenter adapter (outer layer) ──────────────────────────
// The ONLY module in runner/ that owns ctx.ui (issue #2106). Implements the
// inner RunPresenter port over the operator's terminal: widget cadence
// (300ms debounce on event-driven flushes + 2s heartbeat during quiet
// periods), the working-message line, the start announcement and the
// teardown order (widget → working message → status).
//
// Presentation cadence lives here, not in the use cases: spawned-run and
// event-loop only say WHAT a run reports, this file decides HOW and WHEN.

import type { AgentRunState } from "../../config/types.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildWidgetLines } from "../../session/widget.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { getErrorCollector } from "../../pipeline/error-collector.ts";
import type { RunPresenter } from "./presenter.ts";

export interface RunPresenterOptions {
	ctx: ExtensionCommandContext;
	widgetId: string;
	agentName: string;
	model: string;
	state: AgentRunState;
}

/** Event-driven flush debounce — bursts of events render once. */
const FLUSH_DEBOUNCE_MS = 300;

/** Quiet-period heartbeat — keeps the terminal alive while the agent thinks. */
const HEARTBEAT_MS = 2000;

/** Supervisor status slot owned by the runner. */
const STATUS_KEY = "supervisor";

export function createRunPresenter(opts: RunPresenterOptions): RunPresenter {
	const log = getDebugLogger();
	let flushTimer: NodeJS.Timeout | null = null;
	let disposed = false;

	const flushWidget = (): void => {
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

	const scheduleFlush = (): void => {
		if (!flushTimer && !disposed) {
			flushTimer = setTimeout(flushWidget, FLUSH_DEBOUNCE_MS);
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
	}, HEARTBEAT_MS);

	return {
		scheduleFlush,
		setWorkingMessage: (message?: string) => {
			opts.ctx.ui.setWorkingMessage(message);
		},
		announceStart: (agentName: string) => {
			opts.ctx.ui.notify(`Running agent: ${agentName}...`, "info");
			opts.ctx.ui.setStatus(STATUS_KEY, `Running ${agentName}...`);
		},
		// Teardown order is operator-visible: the widget goes first (it is the
		// biggest surface), then the working line, then the status slot.
		clear: () => {
			opts.ctx.ui.setWidget(opts.widgetId, undefined);
			opts.ctx.ui.setWorkingMessage(undefined);
			opts.ctx.ui.setStatus(STATUS_KEY, undefined);
		},
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
