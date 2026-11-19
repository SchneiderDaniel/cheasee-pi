// ─── Boundary runner (R4, R5, R7) ───────────────────────────────
// One ordered evaluation decides everything: COMPLETE > BLOCKED > CAP >
// ROLLOVER > CONTINUE, and it lives in `decideBoundary` (domain). This module
// only applies the verdict: checkpoint the iteration, verify from scratch,
// publish, decide, then write the outcome.
//
// A rollover starts a NEW runtime generation (a plain `runtime.start`) instead
// of replacing Pi's session from a lifecycle handler: session replacement from
// `agent_before_settle` can deadlock (R5.AC3/R5.AC4).

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import {
	decideBoundary,
	describeDecision,
	type BoundaryDecision,
} from "../domain/boundary-policy.ts";
import type { GoalRecord } from "../domain/goal-record.ts";
import { buildGenerationPrompt } from "./goal-prompts.ts";
import { completeGoal } from "./goal-completion.ts";
import { pauseForUser } from "./goal-launch.ts";
import type { GoalPublisher } from "./goal-publication.ts";
import { verifyAll } from "./goal-verification.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { CheckRunner, GoalAgentRuntime, GoalStore } from "./ports.ts";

const SOURCE = "goal-loop";

/** Ports the boundary needs. */
export interface BoundaryDeps {
	checks: CheckRunner;
	runtime: GoalAgentRuntime;
	store: GoalStore;
	publisher: GoalPublisher;
	notify?: NotifyFn;
	now: () => Date;
}

/** The boundary verdict plus the record it was applied to. */
export interface BoundaryOutcome {
	record: GoalRecord;
	decision: BoundaryDecision;
	/** User-facing one-liner. */
	message: string;
}

/** The single boundary entry point shared by settle, post-iteration and rollover. */
export class BoundaryRunner {
	private readonly keeper: RecordKeeper;
	private readonly deps: BoundaryDeps;

	constructor(keeper: RecordKeeper, deps: BoundaryDeps) {
		this.keeper = keeper;
		this.deps = deps;
	}

	/** Checkpoint → verify → publish → decide → apply. */
	async run(): Promise<Result<BoundaryOutcome>> {
		const record = this.keeper.current();
		if (!record) return fail("no active goal");
		if (!this.keeper.hasActiveGoal()) return fail(`goal ${record.id} is ${record.status}`);

		// 1. Post-iteration checkpoint (write #1 of two). The compaction flag is
		// consumed here so it is durable before any decision relies on it.
		const compactionSeen = this.deps.runtime.takeCompactionSeen();
		const counted: GoalRecord = {
			...record,
			iterations: record.iterations + 1,
			windowIterations: record.windowIterations + 1,
			inFlight: false,
			compactionSeen: compactionSeen || record.compactionSeen,
		};
		const checkpointed = await this.keeper.persistOrPause(counted);
		if (!checkpointed.ok) return checkpointed;

		// 2. Verify from scratch, then publish once a work iteration landed.
		const evidence = await this.collectEvidence(checkpointed.value);
		const recordForApply = await this.publishIfNeeded(evidence);
		if (!recordForApply.ok) return recordForApply;

		// 3. Decide on the pre-publication evidence.
		const decision = decideBoundary({
			verification: recordForApply.value.verification,
			prState: evidence.pr?.state ?? "none",
			tokens: this.deps.runtime.contextTokens(),
			rolloverTokens: recordForApply.value.config.rolloverTokens,
			compactionSeen: recordForApply.value.compactionSeen,
			iterations: recordForApply.value.iterations,
			maxIterations: recordForApply.value.config.maxIterations,
			blocker: recordForApply.value.blocker,
		});

		// 4. Apply (write #2 of two).
		const applied = await this.applyDecision(recordForApply.value, decision);
		if (!applied.ok) return applied;
		return {
			ok: true,
			value: { record: applied.value, decision, message: describeDecision(decision) },
		};
	}

	/** Verify every criterion from scratch — stored evidence never counts. */
	private async collectEvidence(record: GoalRecord): Promise<GoalRecord> {
		const sweep = await verifyAll({
			criteria: record.criteria,
			worktree: record.worktree,
			checks: this.deps.checks,
			now: this.deps.now,
		});
		return {
			...record,
			verification: sweep.results,
			blocker: sweep.blocker ?? record.blocker,
		};
	}

	/**
	 * Publish once a work iteration landed on a branch (R3.AC3).
	 *
	 * The decision below still uses the PR state observed BEFORE this call, so a
	 * PR opened at this boundary never satisfies "PR exists" for the same
	 * boundary: completion is judged on evidence that existed when the criteria
	 * were checked.
	 */
	private async publishIfNeeded(record: GoalRecord): Promise<Result<GoalRecord>> {
		const needsPullRequest = !record.pr && record.branch !== null && record.iterations >= 1;
		if (!needsPullRequest) return { ok: true, value: record };
		const published = await this.deps.publisher.publish();
		if (!published.ok) return published;
		if (published.value.status === "paused") return { ok: true, value: published.value };
		return { ok: true, value: { ...record, pr: published.value.pr } };
	}

	/** Apply one boundary decision. */
	private async applyDecision(
		record: GoalRecord,
		decision: BoundaryDecision,
	): Promise<Result<GoalRecord>> {
		const limit = `iteration limit reached (${record.config.maxIterations}) — approve /goal resume to continue`;
		switch (decision.kind) {
			case "complete":
				return await completeGoal({ keeper: this.keeper, deps: this.deps, record });
			case "pause":
				return await pauseForUser(this.keeper, this.deps.notify, record, decision.detail);
			case "pause-cap":
				return await pauseForUser(this.keeper, this.deps.notify, record, limit);
			case "rollover":
				return await this.rollover(record);
			case "continue":
				return await this.keeper.persistOrPause(record);
		}
	}

	/**
	 * Rollover (R5.AC3): checkpoint, then start a fresh generation in the same
	 * worktree from the record alone. Iteration and reset counts stay cumulative.
	 */
	private async rollover(record: GoalRecord): Promise<Result<GoalRecord>> {
		const rolled: GoalRecord = {
			...record,
			resets: record.resets + 1,
			generation: record.generation + 1,
			windowIterations: 0,
			compactionSeen: false,
			inFlight: true,
		};
		this.keeper.setNextAction(record.nextAction || "continue the goal from this record");
		const checkpointed = await this.keeper.persistOrPause(rolled);
		if (!checkpointed.ok) return checkpointed;

		const started = await this.deps.runtime.start({
			goalId: checkpointed.value.id,
			worktree: checkpointed.value.worktree ?? "",
			model: checkpointed.value.config.model,
			prompt: buildGenerationPrompt(checkpointed.value),
			generation: checkpointed.value.generation,
		});
		if (!started.ok) {
			const blocker = `fresh session could not start: ${started.error}`;
			return await pauseForUser(this.keeper, this.deps.notify, checkpointed.value, blocker);
		}
		this.deps.notify?.info(
			`checkpoint saved, fresh session started (reset ${checkpointed.value.resets})`,
		);
		return checkpointed;
	}
}

/** A uniform failure for the boundary preconditions. */
function fail(message: string): Result<BoundaryOutcome> {
	return failure(message, SOURCE);
}
