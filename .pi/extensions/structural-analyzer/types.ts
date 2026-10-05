/**
 * Shared types for structural-analyzer extension.
 *
 * These types are used across all modules in this package and exported
 * for use by the extension entry point and tests.
 */

import { Type, type Static } from "typebox";

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

const SgMatchSchema = Type.Object({
	file: Type.String(),
	lines: Type.String(),
	snippet: Type.String(),
});

/**
 * Output schema for structural_search's `structuredContent`.
 *
 * One permissive object covers both the success shape
 * (`matches`/`results`/`language` plus the truncation signals) and the failure
 * shape (`error`/`stderr`/`exitCode`/`pattern`); `isError` on the result
 * discriminates. Mirrors ask-user's `QnaReadOutputSchema` precedent — pi runs
 * no runtime validation, so this is the declared contract, not an enforcement step.
 */
export const StructuralSearchOutputSchema = Type.Object({
	matches: Type.Number(),
	results: Type.Array(SgMatchSchema),
	language: Type.String(),
	truncated: Type.Optional(Type.Boolean()),
	totalMatches: Type.Optional(Type.Number()),
	error: Type.Optional(Type.String()),
	stderr: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Number()),
	pattern: Type.Optional(Type.String()),
});

/** Machine-readable payload carried by {@link ExecResultResponse.structuredContent}. */
export type StructuralSearchOutput = Static<typeof StructuralSearchOutputSchema>;

/**
 * Response shape from interpretSgExecResult.
 * Matches the AgentToolResult contract used by pi.exec tool execution.
 */
export interface ExecResultResponse {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	structuredContent?: StructuralSearchOutput;
	isError?: boolean;
}
