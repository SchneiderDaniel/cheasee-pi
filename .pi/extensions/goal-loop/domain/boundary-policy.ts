// ─── Boundary policy ─────────────────────────────────────────────
// The ONE place that decides what happens at a loop boundary. The settle gate
// (`agent_before_settle`), the post-iteration check and the rollover driver all
// call `decideBoundary`, so the three call sites cannot disagree at the exact
// iteration where the cap and the threshold coincide (R5.AC2, R7.AC1).
//
// Ordering is the contract: COMPLETE > BLOCKED > CAP > ROLLOVER > CONTINUE.
// Pure: no I/O, no clock, no hidden state.

import type { VerificationResult } from "./goal-record.ts";

/** PR lifecycle as the policy sees it. `none` means "no PR yet". */
export type PrState = "none" | "draft" | "open" | "merged" | "closed";

/** Everything a boundary decision may look at. */
export interface BoundaryInput {
	/** Per-criterion results from the CURRENT verification pass. */
	verification: VerificationResult[];
	/** Pull-request state; anything but `none` counts as "the PR exists". */
	prState: PrState;
	/** Pi-reported tokens in the active context, or null when unknown. */
	tokens: number | null;
	/** Configured rollover threshold (`goalLoop.contextRolloverTokens`). */
	rolloverTokens: number;
	/** An in-place compaction was observed since the last boundary. */
	compactionSeen: boolean;
	/** Completed work iterations, cumulative. */
	iterations: number;
	/** Configured iteration ceiling (`goalLoop.maxIterations`). */
	maxIterations: number;
	/** Set when the loop cannot proceed for an external reason. */
	blocker: string | null;
}

/** Why a boundary paused. */
export type PauseReason =
	/** An external blocker is recorded (git, GitHub, store, verification). */
	| "blocked"
	/** The iteration ceiling was reached with the goal incomplete (R7.AC1). */
	| "iteration-cap";

/** The single decision type every boundary path returns. */
export type BoundaryDecision =
	| { kind: "complete" }
	| { kind: "pause"; reason: PauseReason; detail: string }
	| { kind: "pause-cap" }
	| { kind: "rollover" }
	| { kind: "continue" };

/**
 * Every criterion in the current pass reports `pass`, and there is at least
 * one result. An empty verification list is NOT a pass — a goal with no
 * criteria was never ready to start.
 */
export function allCriteriaPass(verification: VerificationResult[]): boolean {
	return verification.length > 0 && verification.every((v) => v.result === "pass");
}

/** R4.AC2 gate: all criteria pass AND the pull request exists. */
export function isVerifiedComplete(input: {
	verification: VerificationResult[];
	prState: PrState;
}): boolean {
	return allCriteriaPass(input.verification) && input.prState !== "none";
}

/**
 * Decide the boundary outcome.
 *
 * - COMPLETE: all criteria pass and a PR exists. Checked first, so a goal that
 *   finishes exactly at the cap or the token threshold is recorded complete
 *   instead of pausing or rolling over.
 * - BLOCKED: an external blocker on an incomplete goal → pause for the user.
 *   A blocker on a *complete* goal is irrelevant and never suppresses
 *   `complete`.
 * - CAP: the iteration ceiling was reached while incomplete → pause for
 *   explicit approval. Checked before rollover: rolling into a fresh session
 *   cannot make an out-of-iterations goal progress.
 * - ROLLOVER: an in-place compaction was observed, or the active context
 *   reached the configured threshold. `tokens: null` (unknown) never triggers a
 *   rollover on its own.
 * - CONTINUE: everything else.
 */
export function decideBoundary(input: BoundaryInput): BoundaryDecision {
	if (isVerifiedComplete(input)) {
		return { kind: "complete" };
	}

	if (input.blocker) {
		return { kind: "pause", reason: "blocked", detail: input.blocker };
	}

	if (input.iterations >= input.maxIterations) {
		return { kind: "pause-cap" };
	}

	const atThreshold = input.tokens !== null && input.tokens >= input.rolloverTokens;
	if (input.compactionSeen || atThreshold) {
		return { kind: "rollover" };
	}

	return { kind: "continue" };
}

/** Stable one-line description used by user-visible status and logs. */
export function describeDecision(decision: BoundaryDecision): string {
	switch (decision.kind) {
		case "complete":
			return "complete: every acceptance criterion passed and the pull request exists";
		case "pause":
			return `pause (${decision.reason}): ${decision.detail}`;
		case "pause-cap":
			return "pause (iteration-cap): the configured iteration limit was reached";
		case "rollover":
			return "rollover: context checkpoint reached";
		case "continue":
			return "continue: another work iteration";
	}
}
