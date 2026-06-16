// ─── Agent Stream Helpers ──────────────────────────────────────────
// Thin wrapper: delegates event processing to shared adapter + handlers.
// Maintains backward-compatible exports for agent-runner.ts and others.
//
// Owns: filterStderr(), pushLog(), constants.
// Delegates: processJsonLine() → jsonLineToNormalizedEvent() + processNormalizedEvent().

import type { AgentRunState } from "../config/types.ts";
import { formatTokens } from "../lib/formatting.ts";
import { jsonLineToNormalizedEvent, processNormalizedEvent } from "../event/adapter.ts";
import { phasePriority } from "../event/types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { getErrorCollector } from "../pipeline/error-collector.ts";

// ─── Re-exports for backward compat ───────────────────────────────

export { phasePriority } from "../event/types.ts";

// ─── Constants ──────────────────────────────────────────────────────

export const MAX_FULL_LOG = 500;
export const WIDGET_LINES = 20;
export const MAX_LIVE_THINKING = 500;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Filter known non-error patterns from stderr output.
 * Prevents telemetry noise and jiti diagnostic context from
 * polluting error detection.
 *
 * In --mode json, pi redirects process.stdout.write to stderr
 * (takeOverStdout), so extension console.log calls end up here.
 * Additionally, jiti prints source context lines from the
 * importing file (resource-loader.js) when module resolution
 * fails — these look like "import { ... } from \"...\"" fragments.
 */
export function filterStderr(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			// Skip JSON telemetry events
			if (trimmed.startsWith('{"type":"context_info"')) return false;
			// Skip jiti source-context lines (JS import/export fragments)
			if (/^(import\s+|export\s+)/.test(trimmed)) return false;
			// Skip Node.js stack trace lines
			if (/^\s+at\s/.test(line)) return false;
			// Skip empty lines
			if (!trimmed) return false;
			return true;
		})
		.join("\n")
		.trim();
}

/**
 * Push a log entry to state.fullLog with bounded size.
 * Kept here for backward compat — used by event-handlers and session-events.
 */
export function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > MAX_FULL_LOG) state.fullLog.shift();
}

/**
 * Process a single JSON line from pi's stdout.
 * Thin wrapper: converts to NormalizedEvent and delegates to shared processor.
 * Mutates state in place. Returns flush + workingChange flags.
 */
export function processJsonLine(
	line: string,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	if (!line.trim()) return { flush: false, workingChange: false };
	try {
		const normalized = jsonLineToNormalizedEvent(line);
		if (!normalized) return { flush: false, workingChange: false };
		const result = processNormalizedEvent(normalized, state);
		if (result.workingChange) {
			getDebugLogger().debug("agent-stream", `Phase: ${state.phase}`, {
				toolCount: state.toolCount,
				logLen: state.fullLog.length,
				thinkingLen: state.liveThinking.length,
				textLen: state.liveText.length,
			});
		}
		return result;
	} catch (parseErr: unknown) {
		const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
		const errMsg = String(parseErr).slice(0, 200);
		getDebugLogger().warn("agent-stream", `JSON parse error: ${errMsg}`, { preview });
		if (line.trim()) {
			getErrorCollector().push("stream", "warn", `JSON parse error: ${errMsg}`);
		}
		return { flush: false, workingChange: false };
	}
}
