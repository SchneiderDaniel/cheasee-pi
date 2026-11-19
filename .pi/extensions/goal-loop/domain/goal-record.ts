// ─── Goal record entity: shape, statuses, transitions ─────────────
// The durable, session-independent goal state (R2). Pure: no pi, git, gh or
// fs imports — parsing lives in `goal-record-parse.ts` and rendering in
// `goal-record-markdown.ts`, so this module owns only the shape and the
// transition table.
//
// `complete` is reachable only from `verifying`: a record cannot jump from
// `clarifying` or `active` straight to done, because completion is an evidence
// verdict (R4.AC2), never a model claim.

import { failure, type Result } from "../../shared/result.ts";

// ─── Statuses ────────────────────────────────────────────────────

/** Every goal status. `complete` and `cancelled` are terminal. */
export const GOAL_STATUSES = [
	"clarifying",
	"active",
	"verifying",
	"paused",
	"complete",
	"cancelled",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Statuses that block a second `/goal`. Terminal records never block. */
export const ACTIVE_STATUSES: readonly GoalStatus[] = [
	"clarifying",
	"active",
	"verifying",
	"paused",
];

/** Terminal statuses: no transition out of them is legal. */
export const TERMINAL_STATUSES: readonly GoalStatus[] = ["complete", "cancelled"];

/**
 * The complete transition table. Anything absent is rejected.
 *
 * `→ clarifying` is reachable from every non-terminal status: `/goal revise`
 * re-opens the goal (R4.AC4). `→ cancelled` is reachable from every
 * non-terminal status: `/goal stop` is always available (R7.AC2).
 */
const ALLOWED_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
	clarifying: ["active", "cancelled"],
	active: ["verifying", "paused", "cancelled", "clarifying"],
	verifying: ["active", "complete", "clarifying", "cancelled"],
	paused: ["active", "clarifying", "cancelled"],
	complete: [],
	cancelled: [],
};

/** True when `status` blocks a new goal (non-terminal). */
export function isActiveStatus(status: GoalStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

// ─── Verification model ──────────────────────────────────────────

/** A pinned file the harness hashes before running a command verifier. */
export interface PinnedFile {
	path: string;
	sha256: string;
}

/**
 * How one acceptance criterion is checked.
 *
 * `command`: the harness runs `argv` in the worktree (never through a shell)
 * after verifying every pinned hash, so a rewrite of the check script cannot
 * pass. `inspect`: no executable form exists, so a nested fresh-context call
 * judges harness-produced evidence only — a prior record claim never counts.
 */
export type Verifier =
	| { kind: "command"; argv: string[]; pinned: PinnedFile[]; expectExit: number }
	| { kind: "inspect"; instruction: string };

/** One acceptance criterion with its verification method (R1, R4). */
export interface AcceptanceCriterion {
	id: string;
	text: string;
	verifier: Verifier;
}

/** Result of one verification pass for one criterion. */
export interface VerificationResult {
	criterionId: string;
	result: "pass" | "fail";
	/** Where the evidence came from (command line, evidence file, diff ref). */
	evidenceRef: string;
	/** ISO timestamp of the check. */
	checkedAt: string;
}

// ─── Configuration snapshot ──────────────────────────────────────

/** Effective goal-loop configuration snapshotted into the record (R6). */
export interface GoalConfigSnapshot {
	/** `provider/model-id` used for clarification, implementation, verification. */
	model: string;
	/** Context-usage threshold that triggers a fresh-session rollover. */
	rolloverTokens: number;
	/** Maximum completed work iterations before the loop pauses for approval. */
	maxIterations: number;
}

// ─── Record ──────────────────────────────────────────────────────

/** Pull-request reference. `nodeId` is required to un-draft via GraphQL. */
export interface GoalPullRequest {
	number: number;
	nodeId: string;
	state: "draft" | "open" | "merged" | "closed";
}

/** The complete durable goal record (R2.AC2). */
export interface GoalRecord {
	id: string;
	status: GoalStatus;
	/** The literal `/goal` argument. */
	request: string;
	/** Restated, measured goal produced by clarification. */
	clarifiedGoal: string;
	criteria: AcceptanceCriterion[];
	verification: VerificationResult[];
	/** Completed work iterations, cumulative across sessions. */
	iterations: number;
	/** Iterations completed in the current context generation. */
	windowIterations: number;
	/** Context resets performed, cumulative. */
	resets: number;
	/** Current context generation index (0 = first session). */
	generation: number;
	/** ISO timestamp of the last successful record write. */
	lastCheckpoint: string;
	/** The single next action a fresh session resumes from. */
	nextAction: string;
	config: GoalConfigSnapshot;
	worktree: string | null;
	branch: string | null;
	pr: GoalPullRequest | null;
	blocker: string | null;
	steering: string[];
	/** An in-place compaction was observed; the next boundary rolls over. */
	compactionSeen: boolean;
	/** An iteration is running (fail closed on a crashed session). */
	inFlight: boolean;
}

// ─── Transitions ─────────────────────────────────────────────────

/** True when `from → to` is in the transition table (or a no-op). */
export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
	if (from === to) return true;
	return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Assert a legal status transition.
 *
 * A terminal status rejects every transition and the message names both
 * statuses, so the caller's error report is actionable.
 */
export function assertTransition(from: GoalStatus, to: GoalStatus): void {
	if (TERMINAL_STATUSES.includes(from) && from !== to) {
		throw new Error(`illegal goal status transition ${from} → ${to}: ${from} is terminal`);
	}
	if (from !== to && !ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new Error(`illegal goal status transition ${from} → ${to}`);
	}
}

/** Move `record` to `status`, throwing when the transition is illegal. */
export function transitionTo(record: GoalRecord, status: GoalStatus): GoalRecord {
	assertTransition(record.status, status);
	return { ...record, status };
}

/** The single non-terminal record, or a failure naming every conflict. */
export function findActiveRecord(records: GoalRecord[]): Result<GoalRecord | null> {
	const active = records.filter((r) => isActiveStatus(r.status));
	if (active.length === 0) return { ok: true, value: null };
	if (active.length > 1) {
		return failure(
			`multiple active goals found: ${active.map((r) => r.id).join(", ")}`,
			"goal-record",
		);
	}
	return { ok: true, value: active[0]! };
}
