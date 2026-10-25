// ─── Pipeline Merge (barrel) ─────────────────────────────────────
// Two actors, two files (issue #2033 split): the pre-Done PR readiness gate
// lives in `merge-gate.ts`, the post-Done conflict orchestration in
// `merge-post.ts`, the shared conflict resolution in `merge-conflicts.ts`.
// Names are re-exported explicitly so existing importers of merge.ts keep
// working and the surface stays auditable.

export { ensurePrReadyForDone } from "./merge-gate.ts";
export { handlePostPipelineMerge } from "./merge-post.ts";
export { awaitPrMergeability, classifyMergeability, type PrGateVerdict } from "./pr-gate.ts";
