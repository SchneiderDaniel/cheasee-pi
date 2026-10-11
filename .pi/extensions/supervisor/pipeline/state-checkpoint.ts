// ─── Pipeline State Checkpoint (barrel) ───────────────────────────
// Lightweight state checkpoint file for crash recovery.
// Written before heavy/long-running operations so the supervisor can
// detect stale worktrees on restart.
//
// Split for issue #2001 — the implementation lives in three modules and
// this path stays the single import point:
//   - checkpoint-file.ts — file format, write atomicity, staleness logic
//   - run-lock.ts        — per-issue run lock (PID-backed)
//   - stale-cleanup.ts   — startup cleanup of orphaned checkpoints
//
// Both the run lock and the checkpoint are keyed per issue:
//   .pi/supervisor-run-<issueNum>.json
//   .pi/supervisor-state-<issueNum>.json
// Two pipelines on DIFFERENT issues run in parallel (worktree paths are
// per-issue); two pipelines on the SAME issue still serialize on the
// per-issue lock. The scanner also matches the legacy bare-name
// `supervisor-state.json` so a mid-upgrade orphan is still cleaned up.

export {
	isStaleCheckpoint,
	readCheckpointFileFromPath,
	writeCheckpointFile,
	deleteCheckpointFile,
} from "./checkpoint-file.ts";
export type { CheckpointName, SupervisorCheckpointState } from "./checkpoint-file.ts";
export { acquireRunLock, releaseRunLock, isAnyOtherPipelineLive } from "./run-lock.ts";
export { cleanupStalePipelineState } from "./stale-cleanup.ts";
