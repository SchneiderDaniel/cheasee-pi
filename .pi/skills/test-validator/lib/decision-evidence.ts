// Domain: the judged slice and admissible evidence.
//
// A verdict is only meaningful against the exact lines it judged. Evidence is
// admissible when its line is inside the range and its quote really is a
// substring of that range — a quote from a neighbouring test, a re-indented
// quote, or a re-wrapped quote is not evidence.

import type { VerdictEvidence } from "./types.ts";

/** The slice a verdict is judged against. */
export interface VerdictTarget {
	readonly startLine: number;
	readonly endLine: number;
	/** Exact source text of the inclusive line range. */
	readonly text: string;
}

export interface ParsedEvidence {
	readonly line: number;
	readonly quote: string;
}

/** Build the judged slice for a definition from its file source. */
export function verdictTargetFor(
	def: { readonly startLine: number; readonly endLine: number },
	source: string,
): VerdictTarget {
	const text = source
		.split("\n")
		.slice(def.startLine - 1, def.endLine)
		.join("\n");
	return { startLine: def.startLine, endLine: def.endLine, text };
}

/** Plain object check: arrays and null are not envelopes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{line, quote}` entries, or null when the shape is wrong anywhere. */
export function parseEvidence(raw: unknown): ParsedEvidence[] | null {
	if (!Array.isArray(raw)) return null;
	const entries: ParsedEvidence[] = [];
	for (const item of raw) {
		if (!isRecord(item)) return null;
		const line = item.line;
		const quote = item.quote;
		if (typeof line !== "number" || !Number.isInteger(line)) return null;
		if (typeof quote !== "string") return null;
		entries.push({ line, quote });
	}
	return entries;
}

function inRange(target: VerdictTarget, line: number): boolean {
	return line >= target.startLine && line <= target.endLine;
}

/** Evidence is only admissible when it quotes the judged lines verbatim. */
export function isVerbatim(target: VerdictTarget, entry: ParsedEvidence): boolean {
	if (!inRange(target, entry.line)) return false;
	return entry.quote.length > 0 && target.text.includes(entry.quote);
}

export function toVerdictEvidence(entries: readonly ParsedEvidence[]): VerdictEvidence[] {
	return entries.map((entry) => ({ line: entry.line, quote: entry.quote }));
}
