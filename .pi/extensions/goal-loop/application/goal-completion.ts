// ─── Verified completion (R3.AC4, R4.AC2) ───────────────────────
// Completion is a state machine step, not a claim: the goal moves to
// `verifying`, the draft PR is marked ready for review through GraphQL, and
// only then does the record reach `complete`. Nothing merges.

import type { NotifyFn, Result } from "../../shared/result.ts";
import { transitionTo, type GoalRecord } from "../domain/goal-record.ts";
import type { GoalPublisher } from "./goal-publication.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { GoalAgentRuntime, GoalStore } from "./ports.ts";

/** Ports completion needs. */
export interface CompletionDeps {
	publisher: GoalPublisher;
	runtime: GoalAgentRuntime;
	store: GoalStore;
	notify?: NotifyFn;
}

/**
 * Move a fully verified goal to `complete` and release its resources.
 *
 * A failed ready-for-review call pauses the goal with the API message instead
 * of completing it: the PR would otherwise stay a draft while the record
 * claimed review was available.
 */
export async function completeGoal(input: {
	keeper: RecordKeeper;
	deps: CompletionDeps;
	record: GoalRecord;
}): Promise<Result<GoalRecord>> {
	const { keeper, deps } = input;
	const verifying = transitionTo(input.record, "verifying");
	const ready = await deps.publisher.markReady(verifying);
	if (!ready.ok) return ready;
	if (ready.value.status === "paused") return ready;

	const completed = transitionTo({ ...ready.value, blocker: null }, "complete");
	keeper.setNextAction("");
	const persisted = await keeper.persistOrPause(completed);
	if (!persisted.ok) return persisted;
	await deps.runtime.dispose();
	await deps.store.release();
	deps.notify?.info(`goal ${completed.id} complete — pull request left for review`);
	return persisted;
}
