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
}

export interface SessionData {
	sessionId: string;
	timestamp: string;
	entries: SessionEntry[];
}

/**
 * Detector type signature — each waste-signal detector is a pure function
 * that takes parsed SessionData and returns zero or more WasteSignal objects.
 */
export type Detector = (data: SessionData) => WasteSignal[];
