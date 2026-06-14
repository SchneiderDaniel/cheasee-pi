/**
 * Shared types for structural-analyzer extension.
 *
 * These types are used across all modules in this package and exported
 * for use by the extension entry point and tests.
 */

/** Processed match entry in output. */
export interface SgMatch {
	file: string;
	lines: string;
	snippet: string;
}

/** Shaped output for tool result. */
export interface SgResult {
	matches: number;
	results: SgMatch[];
}

/**
 * Response shape from interpretSgExecResult.
 * Matches the AgentToolResult contract used by pi.exec tool execution.
 */
export interface ExecResultResponse {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}
