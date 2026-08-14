// ─── Pipeline Stages — public barrel ─────────────────────────────
// Contract surface for pipeline/stages. Consumers (handler.ts, tests)
// import from here only; per-phase implementation lives in sibling
// modules. Explicit re-exports only — no wildcard re-exports, no logic,
// so the barrel stays free of circular-resolution hazards.

export {
	MAX_PIPELINE_LOOPS,
	createStageState,
	handleBacklogTransition,
	isDoneStatus,
	resolveAgentName,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	applyStatusTransition,
	buildAgentResultEntry,
	shouldSkipResearcher,
	inferForwardStatus,
	buildDuplicateCodeContext,
	applyGateFailureContext,
	buildDeadCodeContext,
	buildVulnContext,
	validateResearcherFindings,
} from "./core.ts";
export type { StageState, AuditGateContext, GateRejected } from "./core.ts";
export {
	buildApprovalCommentFromOutput,
	buildRejectionCommentFromOutput,
	computeAuditGateRejection,
} from "./auditor-output.ts";
export {
	handleEmptyWorktree,
	gatherChangeOnMain,
	gatherOpenPrs,
	dispatchEmptyWorktreeAction,
} from "./empty-worktree.ts";
export type { EmptyWorktreeOutcome } from "./empty-worktree.ts";
export { hasBranchCommits, gitCherryContains } from "./git-ops.ts";
export { handlePostAgentSuccess } from "./post-agent-success.ts";
