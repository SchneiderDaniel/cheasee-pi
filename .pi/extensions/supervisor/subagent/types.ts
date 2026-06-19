// ─── Subagent Types ─────────────────────────────────────────────────
// Type definitions for the subagent tool boundary layer.
// All interfaces are deterministic (zero logic, no functions).

/** A single tool call made by the subagent during execution */
export interface SubagentToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Result of a tool execution (from tool_execution_end event) */
export interface SubagentToolResult {
	name: string;
	isError: boolean;
	/** Tool output/result content (from raw event.result), truncated to 2000 chars */
	result?: string;
	/** Duration of the tool execution in ms (from start → end timestamps) */
	durationMs?: number;
}

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
	toolCalls: SubagentToolCall[];
	/** Results of completed tool executions (same index order as toolCalls when available) */
	toolResults: SubagentToolResult[];
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

/** Image content block for AgentToolResult */
export interface ImageContent {
	type: "image";
	data: string;
	mediaType: string;
}

/**
 * AgentToolResult — compatible with pi's tool execution system.
 * Used as return type of executeSubagent() and as onUpdate partial.
 */
export interface AgentToolResult<TDetails = Record<string, unknown>> {
	content: (TextContent | ImageContent)[];
	details: TDetails;
	terminate?: boolean;
}

/**
 * Parameters accepted by executeSubagent().
 */
export interface ExecuteSubagentParams {
	/** Agent name (e.g., "architect", "developer", "auditor", "researcher", "test-designer") */
	agent: string;
	/** Full task prompt to execute */
	task: string;
	/** Working directory for the subagent session (worktree path if applicable) */
	cwd?: string;
	/** Max tool calls before budget exceeded (0 = unlimited) */
	maxToolCalls?: number;
	/** Max token budget before budget exceeded (0 = unlimited) */
	agentTokenBudget?: number;
}
