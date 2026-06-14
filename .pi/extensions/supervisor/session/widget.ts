// ─── Session Widget Builders ──────────────────────────────────────
// Pure functions for TUI widget building — no side effects.
// Extracted from agent-stream.ts to keep files modular.

import type { AgentRunState } from "../config/types.ts";
import { formatTokens, formatDuration } from "../lib/formatting.ts";
import { WIDGET_LINES, MAX_LIVE_THINKING } from "../agent/stream.ts";

// Re-export constants for backward compatibility
export { WIDGET_LINES, MAX_LIVE_THINKING } from "../agent/stream.ts";

/**
 * Build widget lines from state. Pure function — no side effects.
 * pi caps string-array widgets at MAX_WIDGET_LINES (10).
 * We reserve space for fixed content + footer so stats are never truncated.
 */
export function buildWidgetLines(
	state: AgentRunState,
	agentName: string,
	model?: string,
	idleWarning?: string | null,
): string[] {
	const now = Date.now();

	// pi caps string-array widgets at 10 lines. Keep footer always visible.
	const MAX = 10;

	// ── Fixed lines (always present) ──
	const fixed: string[] = [];
	fixed.push(`⚙ ${agentName}`);

	if (
		state.contextInfoReceived &&
		state.contextTokens !== undefined &&
		state.contextWindow !== undefined
	) {
		fixed.push(
			`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`,
		);
	} else {
		fixed.push("  Context: computing...");
	}

	// ── Phase-specific lines (0-2) ──
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		fixed.push(`  💭 ${state.liveThinking.trimEnd().slice(-200)}`);
	}
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		fixed.push(`  🔧 ${toolLabel}`);
	}

	// ── Live text (0-1 line, between logs and footer) ──
	const hasLiveText = state.phase === "text" && state.liveText.trim();
	const liveTextLine = hasLiveText ? `  ${state.liveText.trimEnd().slice(-200)}` : undefined;

	// ── Idle warning (optional, shown when no events for >15s) ──
	const idleLine = idleWarning ? `  ${idleWarning}` : undefined;

	// ── Cache stats helper ──
	function fmtCacheVal(n: number | undefined | null): string {
		if (n === undefined || n === null) return "--";
		return formatTokens(n);
	}

	// ── Stats footer (always included) ──
	const shortModel = model ? model.split("/").pop() || model : undefined;
	const statsParts: string[] = [`subagent:${agentName}`];
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	const cacheRead = state.cacheRead;
	const cacheWrite = state.cacheWrite;
	if (cacheRead !== undefined || cacheWrite !== undefined) {
		statsParts.push(`📦 ${fmtCacheVal(cacheRead)}/${fmtCacheVal(cacheWrite)}`);
	}
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	statsParts.push(`⏱ ${formatDuration(now - state.startedAt)}`);
	const footer = `  ${statsParts.join(" · ")}`;

	// ── Compute space for log entries ──
	const fixedCount = fixed.length;
	const footerCount = 1;
	const liveTextCount = liveTextLine ? 1 : 0;
	const idleLineCount = idleLine ? 1 : 0;
	const maxLogLines = MAX - fixedCount - liveTextCount - idleLineCount - footerCount;

	const lines: string[] = [...fixed];

	if (maxLogLines > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-maxLogLines);
		for (const entry of recent) {
			const display = entry.length > 200 ? entry.slice(0, 197) + "..." : entry;
			lines.push(`  ${display}`);
		}
	}

	if (liveTextLine) lines.push(liveTextLine);
	if (idleLine) lines.push(idleLine);
	lines.push(footer);

	return lines;
}

/** Build working message from phase. Priority: tool > thinking > text. */
export function getWorkingMessage(state: AgentRunState, agentName: string): string | null {
	switch (state.phase) {
		case "tool":
			if (state.currentTool) return `${agentName}: ${state.currentTool}`;
			return `${agentName}: working...`;
		case "thinking":
			return `${agentName}: thinking...`;
		case "text":
			return `${agentName}: responding...`;
		default:
			return null;
	}
}
