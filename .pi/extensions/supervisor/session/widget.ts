// ─── Session Widget Builders ──────────────────────────────────────
// Pure functions for TUI widget building — no side effects.
// Extracted from agent-stream.ts to keep files modular.

import type { AgentRunState } from "../config/types.ts";
import type { SubagentDetails } from "../subagent/types.ts";
import { formatTokens, formatDuration, thinkingLabel } from "../lib/formatting.ts";

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
	now?: number,
): string[] {
	const nowTs = now ?? Date.now();

	// ponytail: only stats footer line — no headers, no log entries, no tool listing.
	const shortModel = model ? model.split("/").pop() || model : undefined;
	const statsParts: string[] = [`subagent:${agentName}`];
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	const tl = thinkingLabel(state.thinkingLevel);
	if (tl) statsParts.push(tl);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	const cacheRead = state.cacheRead;
	const cacheWrite = state.cacheWrite;
	if ((cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0) {
		const fmtCacheVal = (n: number | undefined | null): string => {
			if (n === undefined || n === null) return "--";
			return formatTokens(n);
		};
		statsParts.push(`📦 ${fmtCacheVal(cacheRead)}/${fmtCacheVal(cacheWrite)}`);
	}
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	statsParts.push(`⏱ ${formatDuration(nowTs - state.startedAt)}`);

	return [`  ${statsParts.join(" · ")}`];
}

/**
 * Render widget from SubagentDetails — constructs AgentRunState and calls buildWidgetLines().
 * Shared helper used by both executeAgent() onUpdate (Path A) and
 * handlePostPipelineMerge() onUpdate (Path B) for consistent widget rendering.
 *
 * All new SubagentDetails fields are optional — the function gracefully degrades
 * when fields are missing (e.g. contextTokens/contextWindow undefined → "computing...").
 */
export function renderWidgetFromDetails(
	details: Partial<SubagentDetails>,
	agentName: string,
	model: string | undefined,
	ctx: { ui: { setWidget: (id: string, lines?: string[] | undefined) => void } },
	widgetId: string,
): void {
	// Map SubagentDetails.phase string to AgentPhase
	const phase =
		details.phase === "thinking" || details.phase === "tool" || details.phase === "text"
			? details.phase
			: "idle";

	// Construct minimal AgentRunState from details
	// buildWidgetLines() only accesses: contextInfoReceived, contextTokens, contextWindow,
	// phase, liveThinking, currentTool, currentToolArgs, liveText, fullLog,
	// toolCount, tokenCount, cacheRead, cacheWrite, startedAt
	const state: AgentRunState = {
		phase,
		startedAt: details.startedAt ?? Date.now(),
		tokenCount: details.runningTokenCount ?? 0,
		toolCount: details.runningToolCount ?? details.toolCalls?.length ?? 0,
		fullLog: details.recentLogEntries ?? [],
		liveThinking: details.liveThinking ?? "",
		liveText: details.liveText ?? "",
		contextTokens: details.contextTokens,
		contextWindow: details.contextWindow,
		contextInfoReceived: details.contextTokens !== undefined && details.contextWindow !== undefined,
		currentTool: details.currentTool,
		currentToolArgs: details.currentToolArgs,
		thinkingLevel: details.thinkingLevel,
		// Fields required by interface:
		textOutputLines: [],
		thinkingOutputLines: [],
		cacheRead: details.cacheRead,
		cacheWrite: details.cacheWrite,
		lastToolName: undefined,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: details.maxToolCalls ?? 0,
		failedToolCount: details.errorCount ?? 0,
		agentTokenBudget: details.agentTokenBudget ?? 0,
	};

	const lines = buildWidgetLines(state, agentName, model);
	ctx.ui.setWidget(widgetId, lines);
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
