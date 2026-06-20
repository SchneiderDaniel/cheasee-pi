/**
 * session-analyzer.ts — Composition root for waste-signal detectors
 *
 * Composes all 8 detectors, runs them on parsed SessionData, deduplicates
 * overlapping signals, and merges results into sorted WasteSignal[].
 *
 * Application layer: imports 8 detectors directly, owns dedup/merge logic.
 * No I/O, no node:fs.
 */

import type { SessionData, WasteSignal, SessionAnalysis } from "./types.ts";
import { detectRedundantReads } from "./waste-signals/redundant-reads.ts";
import { detectIdenticalArgs } from "./waste-signals/identical-args.ts";
import { detectBashGrep } from "./waste-signals/bash-grep.ts";
import { detectBashCat } from "./waste-signals/bash-cat.ts";
import { detectErrorLoop } from "./waste-signals/error-loop.ts";
import { detectNoBatch } from "./waste-signals/no-batch.ts";
import { detectTurnInefficiency } from "./waste-signals/turn-inefficiency.ts";
import { detectStructuralSearchUnderuse } from "./waste-signals/structural-underuse.ts";

/**
 * Run all detectors on a parsed session.
 * Returns WasteSignal[] sorted by wastedTokens descending (largest waste first).
 *
 * Dedup: signals with same `${signal}|${toolName}|${files}` key get merged
 * (summed tokens/cost, merged details/turnRange).
 */
export function analyzeSession(data: SessionData): WasteSignal[] {
	const allSignals: WasteSignal[] = [
		...detectRedundantReads(data),
		...detectIdenticalArgs(data),
		...detectBashGrep(data),
		...detectBashCat(data),
		...detectErrorLoop(data),
		...detectNoBatch(data),
		...detectTurnInefficiency(data),
		...detectStructuralSearchUnderuse(data),
	];

	// Dedup by signal+context (same key = same underlying issue, merge)
	const merged = new Map<string, WasteSignal>();
	for (const s of allSignals) {
		const key = `${s.signal}|${s.context.toolName ?? ""}|${(s.context.files ?? []).join(",")}`;
		if (merged.has(key)) {
			const existing = merged.get(key)!;
			existing.wastedTokens += s.wastedTokens;
			existing.wastedCost += s.wastedCost;
			existing.occurrences += s.occurrences;
			existing.details.push(...s.details);
			if (s.context.turnRange) {
				if (!existing.context.turnRange) existing.context.turnRange = s.context.turnRange;
				else {
					existing.context.turnRange = [
						Math.min(existing.context.turnRange[0], s.context.turnRange[0]),
						Math.max(existing.context.turnRange[1], s.context.turnRange[1]),
					];
				}
			}
		} else {
			merged.set(key, { ...s, details: [...s.details] });
		}
	}

	return [...merged.values()].sort((a, b) => b.wastedTokens - a.wastedTokens);
}

/**
 * Build SessionAnalysis from parsed session data + waste signals.
 */
export function buildSessionAnalysis(
	data: SessionData,
	signals: WasteSignal[],
	metadata?: { totalTokens?: number; totalCost?: number },
): SessionAnalysis {
	const totalWasteTokens = signals.reduce((s, w) => s + w.wastedTokens, 0);
	const totalWasteCost = signals.reduce((s, w) => s + w.wastedCost, 0);
	const totalTokens = metadata?.totalTokens ?? totalWasteTokens * 3; // fallback heuristic
	const totalCost = metadata?.totalCost ?? totalWasteCost * 3;

	return {
		sessionId: data.sessionId,
		timestamp: data.timestamp,
		totalTokens,
		totalCost,
		totalWasteTokens,
		totalWasteCost,
		wasteFraction: totalTokens > 0 ? totalWasteTokens / totalTokens : 0,
		wasteBySignal: signals,
	};
}
