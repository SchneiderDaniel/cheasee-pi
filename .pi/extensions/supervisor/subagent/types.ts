// ─── Subagent Types ─────────────────────────────────────────────────
// Type definitions for the subagent tool boundary layer.
// All interfaces are deterministic (zero logic, no functions).

/** A single tool call made by the subagent during execution */
export interface SubagentToolCall {
	name: string;
	args: Record<string, unknown>;
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
	/** Full task prompt given to the subagent */
	taskPrompt: string;
	/** Whether the subagent exceeded its token/tool budget */
	budgetExceeded?: boolean;
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
