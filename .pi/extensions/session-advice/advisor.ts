/**
 * advisor.ts — Re-export facade for session-advice
 *
 * Thin pass-through that re-exports all public symbols from the split modules.
 * Consumers (advice-pipeline.ts, index.ts, llm-advisor.ts) import from here
 * with zero import changes.
 *
 * 8 lines total — intentionally shallow (isolates migration risk).
 */

export { parseJsonlFile } from "./jsonl-parser.ts";
export { analyzeSession, buildSessionAnalysis } from "./session-analyzer.ts";
export type { WasteSignal, SessionAnalysis, SessionEntry, SessionData } from "./types.ts";
