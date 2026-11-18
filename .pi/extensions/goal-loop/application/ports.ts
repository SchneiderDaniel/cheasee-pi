// ─── Goal-loop ports ─────────────────────────────────────────────
// The application layer talks to the outside world only through these
// interfaces. Use-case tests inject fakes; production wires the adapters in
// `adapters/`. No port decides policy — every method returns `Result`.
//
// `GoalStore` deliberately has no "delete": a completed record is retained
// (R2.AC1).

import type { AcceptanceCriterion, GoalPullRequest, GoalRecord } from "../domain/goal-record.ts";
export type { AcceptanceCriterion, GoalPullRequest, GoalRecord } from "../domain/goal-record.ts";
import type { Result } from "../../shared/result.ts";
import type { GoalLoopSettings } from "../config/goal-loop-settings.ts";

// ─── Model resolution ────────────────────────────────────────────

/** A resolved model reference with the context capacity the gate needs. */
export interface ResolvedGoalModel {
	/** The configured `provider/model-id` string. */
	ref: string;
	/** Catalog model id. */
	id: string;
	provider: string;
	/** Model context window in tokens. */
	contextWindow: number;
}

/**
 * Resolve a `provider/model-id` string to a catalog model. Called with the
 * configured string only — never with a session model.
 */
export type ModelResolver = (ref: string) => {
	id: string;
	provider: string;
	contextWindow: number;
};

/** Effective configuration for one goal run (R6). */
export interface GoalRuntimeConfig {
	settings: GoalLoopSettings;
	model: ResolvedGoalModel;
}

/** Load + validate settings, resolve the model, gate capacity (R6.AC4). */
export type LoadGoalConfig = () => Result<GoalRuntimeConfig>;

// ─── Durable state ───────────────────────────────────────────────

/** Append/overwrite one goal record as Markdown (atomic write, fail-closed read). */
export interface GoalStore {
	/** Write (create or replace) the record. Failure must pause the loop. */
	write(record: GoalRecord): Promise<Result<void>>;
	read(id: string): Promise<Result<GoalRecord>>;
	list(): Promise<Result<GoalRecord[]>>;
	/** Exclusive lock across processes; a live lock holder refuses the start. */
	acquire(): Promise<Result<void>>;
	release(): Promise<void>;
}

// ─── Isolated workspace ──────────────────────────────────────────

export interface PrepareWorkspaceInput {
	goalId: string;
	/** Branch the goal worktree must carry. */
	branch: string;
}

/**
 * Workspace preparation outcome.
 *
 * `clean: false` is a POLICY refusal (dirty or detached checkout) — the
 * adapter has already declined to touch anything. A git failure is a failed
 * `Result` instead.
 */
export type WorkspaceOutcome =
	{ clean: true; path: string; branch: string; head: string } | { clean: false; reason: string };

/** Git worktree + branch operations for one goal (R3). */
export interface GoalWorkspace {
	/** Refuse a dirty/detached checkout, then create the HEAD-based worktree. */
	prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceOutcome>>;
	/**
	 * Remove the worktree. `confirmed: false` must be refused — the worktree
	 * and branch are retained until the user explicitly confirms cleanup
	 * (R3.AC5).
	 */
	cleanupWorktree(input: { path: string; confirmed: boolean }): Promise<Result<void>>;
}

// ─── Pull requests ───────────────────────────────────────────────

export interface OpenDraftInput {
	branch: string;
	base: string;
	title: string;
	body: string;
}

/**
 * Pull-request operations for goal review (R3.AC3/AC4).
 *
 * There is deliberately no merge and no close operation: the goal loop never
 * merges or closes a PR.
 */
export interface PullRequestPort {
	/** Open a draft PR; must return the GraphQL node id needed to un-draft. */
	openDraft(input: OpenDraftInput): Promise<Result<{ number: number; nodeId: string }>>;
	updateBody(input: { number: number; body: string }): Promise<Result<void>>;
	/** GraphQL-only: REST silently ignores `draft: false`. */
	markReadyForReview(nodeId: string): Promise<Result<void>>;
	getState(number: number): Promise<Result<GoalPullRequest["state"]>>;
}

// ─── Agent runtime ───────────────────────────────────────────────

export interface StartGenerationInput {
	goalId: string;
	/** cwd for the new session — always the goal worktree. */
	worktree: string;
	/** Resolved `provider/model-id` for this run. */
	model: string;
	/** Derived from the record only; no prior transcript is passed. */
	prompt: string;
	generation: number;
}

/**
 * One context generation = one agent session. Rollover starts a NEW generation
 * (a plain `start` call) instead of replacing the session from a lifecycle
 * handler, which could deadlock (R5.AC3/R5.AC4).
 */
export interface GoalAgentRuntime {
	start(input: StartGenerationInput): Promise<Result<{ generation: number }>>;
	/** Forward a steering message to the running generation (R4.AC4). */
	steer(text: string): Promise<Result<void>>;
	/** Stop the running generation immediately (R7.AC2). */
	abort(): Promise<Result<void>>;
	/** Release the runtime after a terminal or paused goal. */
	dispose(): Promise<void>;
	/** Tokens in the active context as reported by Pi, or null when unknown. */
	contextTokens(): number | null;
	/** True when an in-place compaction was observed since the last read. */
	takeCompactionSeen(): boolean;
}

// ─── Verification ────────────────────────────────────────────────

/** One fresh verification result. */
export interface CheckOutcome {
	result: "pass" | "fail";
	/** Where the evidence came from — quoted in the record and in `/goal status`. */
	evidenceRef: string;
}

/**
 * Run one criterion's verifier from the harness (never from the agent's claim).
 * A failure to run at all is a failed `Result`, which blocks completion.
 */
export interface CheckRunner {
	run(criterion: AcceptanceCriterion, worktree: string): Promise<Result<CheckOutcome>>;
}
