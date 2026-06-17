/**
 * session-logger — Session report & enriched metadata
 *
 * Generates .md reports alongside .jsonl session files, tracks tool
 * execution lifecycle, per-turn token breakdown, file access, and errors.
 *
 * Toggle with /session-logger.
 *
 * Architecture: Wiring layer — command registration + gate management.
 * Event handling delegated to LoggerPipeline (pipeline.ts).
 * Report generation in report.ts.
 */

import { createExtensionStateStore } from "../lib/extension-state.ts";
import type { ExtensionStateStore } from "../lib/extension-state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LoggerPipeline } from "./pipeline.ts";
import { generateMissingReports } from "./report.ts";
import type { SessionLoggerGate } from "./types.ts";

export function createSessionLoggerGate(initiallyEnabled = true): SessionLoggerGate {
	return {
		enabledForNextSession: initiallyEnabled,
		sessionEnabled: initiallyEnabled,
	};
}

export function toggleSessionLoggerGate(gate: SessionLoggerGate, args?: string): boolean {
	const normalized = args?.toLowerCase();
	if (normalized === "on") gate.enabledForNextSession = true;
	else if (normalized === "off") gate.enabledForNextSession = false;
	else gate.enabledForNextSession = !gate.enabledForNextSession;
	return gate.enabledForNextSession;
}

export function beginSessionLoggerSession(gate: SessionLoggerGate): boolean {
	gate.sessionEnabled = gate.enabledForNextSession;
	return gate.sessionEnabled;
}

/**
 * Extension entry point.
 * Registers the /session-logger command and wires event handlers
 * to a LoggerPipeline instance.
 */
export default function (pi: ExtensionAPI): void {
	const gate = createSessionLoggerGate();

	// ── Shared extension state (replaces duplicated writeExtState) ──
	const extState: ExtensionStateStore = createExtensionStateStore(
		".pi/state/session-extensions.json",
	);
	extState.setKey("logger", true);
	extState.saveState().catch(() => {}); // Fire-and-forget on init

	pi.registerCommand("session-logger", {
		description: "Toggle session report on/off (takes effect next session)",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();
			const enabled = toggleSessionLoggerGate(gate, cmd);
			extState.setKey("logger", enabled);
			try {
				await extState.saveState();
			} catch (err) {
				ctx.ui.notify(`Failed to persist session-logger state: ${(err as Error).message}`, "error");
			}
			ctx.ui.notify(`Session logger: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	const pipeline = new LoggerPipeline(gate);

	// ── Session lifecycle ──

	pi.on("session_start", async (event, ctx) => {
		// Capture session name and mode for report metadata
		const sessionName = typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;
		const mode = (ctx as any).mode;
		const overrides: { sessionName?: string; mode?: string } = {};
		if (sessionName) overrides.sessionName = sessionName;
		if (mode !== undefined) overrides.mode = mode;
		await pipeline.onSessionStart(
			event,
			ctx,
			Object.keys(overrides).length > 0 ? overrides : undefined,
		);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Gate report generation on project trust
		if (typeof (ctx as any).isProjectTrusted === "function") {
			const trusted = await (ctx as any).isProjectTrusted();
			if (!trusted) {
				if (typeof (ctx as any).ui?.notify === "function") {
					(ctx as any).ui.notify("Session logging skipped: project not trusted", "warning");
				}
				return;
			}
		}
		await pipeline.onSessionShutdown(event, ctx);
	});

	pi.on("session_compact", async () => {
		pipeline.onSessionCompact();
	});

	// ── Model / thinking changes ──

	pi.on("model_select", async (event) => {
		pipeline.onModelSelect(event);
	});

	pi.on("thinking_level_select", async (event) => {
		pipeline.onThinkingLevelSelect(event);
	});

	// ── Turn lifecycle ──

	pi.on("turn_start", async (event) => {
		pipeline.onTurnStart(event);
	});

	pi.on("turn_end", async () => {
		pipeline.onTurnEnd();
	});

	// ── Message tracking ──

	pi.on("message_end", async (event) => {
		pipeline.onMessageEnd(event);
	});

	// ── Tool execution lifecycle ──

	pi.on("tool_execution_start", async (event) => {
		pipeline.onToolExecutionStart(event);
	});

	pi.on("tool_execution_end", async (event) => {
		pipeline.onToolExecutionEnd(event);
	});

	// ── File modification tracking via tool_call interception ──

	pi.on("tool_call", async (event) => {
		pipeline.onToolCall(event);
	});
}

// Re-export for backward compatibility (existing tests import from index.ts)
export { generateMissingReports };
