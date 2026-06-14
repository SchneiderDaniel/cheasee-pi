/**
 * waste-signals/index.ts — Barrel for session-analyzer.ts
 *
 * Re-exports all 8 detector functions. Consumed by session-analyzer.ts only.
 * NOT for use in tests (node --experimental-strip-types does not resolve barrels).
 */

export { detectRedundantReads } from "./redundant-reads.ts";
export { detectIdenticalArgs } from "./identical-args.ts";
export { detectBashGrep } from "./bash-grep.ts";
export { detectBashCat } from "./bash-cat.ts";
export { detectErrorLoop } from "./error-loop.ts";
export { detectNoBatch } from "./no-batch.ts";
export { detectTurnInefficiency } from "./turn-inefficiency.ts";
export { detectStructuralSearchUnderuse } from "./structural-underuse.ts";
