// ─── Verification sweep (R4.AC1/R4.AC2) ──────────────────────────
// Every criterion is re-run from scratch at every boundary: the record's stored
// evidence never counts, so a forged or stale record cannot satisfy the gate.
// A run that fails to execute blocks completion instead of reporting a pass.

import type { AcceptanceCriterion, VerificationResult } from "../domain/goal-record.ts";
import type { CheckRunner } from "./ports.ts";

/** One sweep's outcome: fresh results plus a blocker when the sweep aborted. */
export interface VerificationSweep {
	results: VerificationResult[];
	/** Non-null when a verifier could not run — completion is then impossible. */
	blocker: string | null;
}

/** Run every criterion's verifier in the goal worktree. */
export async function verifyAll(input: {
	criteria: AcceptanceCriterion[];
	worktree: string | null;
	checks: CheckRunner;
	now: () => Date;
}): Promise<VerificationSweep> {
	const worktree = input.worktree;
	if (!worktree) {
		return { results: [], blocker: "no worktree to verify against" };
	}
	const results: VerificationResult[] = [];
	for (const criterion of input.criteria) {
		let outcome;
		try {
			outcome = await input.checks.run(criterion, worktree);
		} catch (err: unknown) {
			return { results, blocker: describeRunFailure(criterion.id, err) };
		}
		if (!outcome.ok) {
			return {
				results,
				blocker: `verification could not run for ${criterion.id}: ${outcome.error}`,
			};
		}
		results.push({
			criterionId: criterion.id,
			result: outcome.value.result,
			evidenceRef: outcome.value.evidenceRef,
			checkedAt: input.now().toISOString(),
		});
	}
	return { results, blocker: null };
}

/** Normalize a thrown verifier error into the blocker text. */
function describeRunFailure(criterionId: string, err: unknown): string {
	const reason = err instanceof Error ? err.message : String(err);
	return `verification could not run for ${criterionId}: ${reason}`;
}
