/**
 * types.ts — Shared types for session-advice extension
 *
 * All type definitions extracted from session-analyzer.ts for reuse across
 * detectors, analyzer, jsonl parser, and consumers.
 *
 * Domain layer: zero pi dependencies, zero I/O.
 */

export interface WasteSignal {
	signal: string;
	label: string;
	wastedTokens: number;
	wastedCost: number;
	occurrences: number;
	details: string[];
	context: {
		turnRange?: [number, number];
		files?: string[];
		toolName?: string;
	};
}

export interface SessionAnalysis {
	sessionId: string;
	timestamp: string;
	totalTokens: number;
	totalCost: number;
	totalWasteTokens: number;
	totalWasteCost: number;
	wasteFraction: number;
	wasteBySignal: WasteSignal[];
}

export interface SessionEntry {
	type: string;
	toolName?: string;
	isError?: boolean;
	args?: Record<string, unknown>;
	text?: string;
	turnIndex: number;
	/** Actual assistant token cost for the call that produced this entry (0 if toolResult) */
	assistantCost?: number;
	/** Assistant usage object from the message that produced this entry */
	usage?: { input: number; output: number; totalTokens: number; cost?: number };
	/** Tool result text length (chars) */
	outputSize?: number;
	/**
	 * Estimated tokens of the paired tool_result's content — i.e. the amount
	 * this call injected into context. Preferred over `assistantCost` for waste
	 * accounting because `assistantCost` carries the full growing prompt and
	 * sums cumulatively, inflating waste ~5-10x. See issue #1084.
	 */
	resultTokens?: number;
}

export interface SessionData {
	sessionId: string;
	timestamp: string;
	entries: SessionEntry[];
}
