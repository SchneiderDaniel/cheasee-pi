// ─── Subagent Types ─────────────────────────────────────────────────
// Type definitions for the subagent tool boundary layer.
// All interfaces are deterministic (zero logic, no functions).

/** Details carried in AgentToolResult.details for the subagent tool */
export interface SubagentDetails {
	agentName: string;
	success: boolean;
	statusLabel: string;
	summaryLine: string;
	/** Model identifier (e.g. "anthropic/claude-sonnet-4-20250514") */
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turnCount: number;
	durationMs: number;
	/** List of tool calls made by the subagent (for renderResult display) */
	toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
	/** Results of completed tool executions (same index order as toolCalls when available) */
	toolResults: Array<{ name: string; isError: boolean; result?: string; durationMs?: number }>;
	/** Full task prompt given to the subagent */
	taskPrompt: string;
	/** Whether the subagent exceeded its token/tool budget */
	budgetExceeded?: boolean;
	/** Running token count during execution (from state) */
	runningTokenCount?: number;
	/** Running tool call count during execution (from state) */
	runningToolCount?: number;
	/** Running count of errored tool results */
	errorCount?: number;
	/** Max tool calls allowed (0 = unlimited, populated from config) */
	maxToolCalls?: number;
	/** Max tokens allowed (0 = unlimited, populated from config) */
	agentTokenBudget?: number;
	/** Whether the session was compacted (context truncated) */
	compacted?: boolean;
	/** Thinking output from the subagent, separate from result text */
	thinkingOutput?: string;

	// ─── Widget rendering fields (populated during execution) ──
	/** Current phase: "idle" | "thinking" | "tool" | "text" */
	phase?: string;
	/** Current tool name during tool execution phase */
	currentTool?: string;
	/** Current tool arguments as JSON string */
	currentToolArgs?: string;
	/** Recent log entries (last N, truncated for widget budget) */
	recentLogEntries?: string[];
	/** Current live thinking content */
	liveThinking?: string;
	/** Current live text output */
	liveText?: string;
	/** Context token count (from contextInfoReceived event) */
	contextTokens?: number;
	/** Context window size (from contextInfoReceived event) */
	contextWindow?: number;
	/** Session start timestamp (Date.now()) */
	startedAt?: number;
}

/** Text content block for AgentToolResult */
export interface TextContent {
	type: "text";
	text: string;
}

/**
 * AgentToolResult — compatible with pi's tool execution system.
 * Used as return type of executeSubagent() and as onUpdate partial.
 */
export interface AgentToolResult<TDetails = Record<string, unknown>> {
	content: TextContent[];
	details: TDetails;
	terminate?: boolean;
}
