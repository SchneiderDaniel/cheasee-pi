// ─── Goal start (R1.AC1, R2.AC4, R3.AC1) ────────────────────────
// `/goal <request>` only records a `clarifying` goal: no worktree, branch or
// session exists until clarification is ready (`goal-clarify.ts`).

import { failure, type Result } from "../../shared/result.ts";
import type { AcceptanceCriterion, GoalRecord } from "../domain/goal-record.ts";
import { createGoalRecord, makeGoalId } from "../domain/goal-record-id.ts";
import type { LaunchDeps } from "./goal-launch.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { GoalStore, LoadGoalConfig } from "./ports.ts";

const SOURCE = "goal-loop";

/** What the agent submits when it has finished clarifying. */
export interface ClarificationSubmission {
	/** The agent judges the goal clear, reachable and verifiable. */
	ready: boolean;
	/** Focused questions, bounded to five by the service. */
	questions?: string[];
	/** Restated measurable goal. */
	clarifiedGoal?: string;
	criteria?: AcceptanceCriterion[];
	/** The agent judged the goal unreachable. */
	reachable?: boolean;
}

export interface ClarificationOutcome {
	record: GoalRecord;
	/** Questions the user must answer; empty once the goal started. */
	questions: string[];
	/** True when the worktree was created and the first generation started. */
	started: boolean;
}

/** Ports the starter needs. */
export interface GoalStartDeps extends LaunchDeps {
	store: GoalStore;
	loadConfig: LoadGoalConfig;
	now: () => Date;
}

/** The refusal shared by both active-goal checks (R3.AC1). */
function activeGoalMessage(goalId: string): string {
	return `a goal is already active (${goalId}) — run /goal stop before starting another`;
}

/**
 * `/goal <request>` and the clarification gate.
 *
 * One record write before every side effect, so the durable state never lags a
 * worktree, branch or session (R2.AC3).
 */
export class GoalStarter {
	private readonly keeper: RecordKeeper;
	private readonly deps: GoalStartDeps;

	constructor(keeper: RecordKeeper, deps: GoalStartDeps) {
		this.keeper = keeper;
		this.deps = deps;
	}

	/**
	 * `/goal <request>`: validate configuration, refuse a second active goal,
	 * create the `clarifying` record.
	 *
	 * No worktree, branch or session is created here (R1.AC1/R1.AC2).
	 */
	async start(request: string): Promise<Result<GoalRecord>> {
		const current = this.keeper.current();
		if (this.keeper.hasActiveGoal() && current) {
			return failure(activeGoalMessage(current.id), SOURCE);
		}
		const trimmed = request.trim();
		if (!trimmed) return failure("usage: /goal <description>", SOURCE);

		const config = this.deps.loadConfig();
		if (!config.ok) return failure(`cannot start goal: ${config.error}`, SOURCE);

		const claimed = await this.claimDirectory();
		if (!claimed.ok) return claimed;

		const created = createGoalRecord({
			id: makeGoalId(trimmed, this.deps.now()),
			request: trimmed,
			config: {
				model: config.value.settings.model,
				rolloverTokens: config.value.settings.contextRolloverTokens,
				maxIterations: config.value.settings.maxIterations,
			},
			now: this.deps.now(),
		});

		const persisted = await this.keeper.persist(created);
		if (!persisted.ok) {
			// R2.AC4: do not start when the initial record cannot be created.
			await this.deps.store.release();
			return persisted;
		}
		return { ok: true, value: persisted.value };
	}

	/** Refuse a second non-terminal record, then take the cross-process lock. */
	private async claimDirectory(): Promise<Result<void>> {
		const existing = await this.deps.store.list();
		if (!existing.ok) {
			return failure(`cannot read existing goal records: ${existing.error}`, SOURCE);
		}
		const active = existing.value.filter(
			(r) => r.status !== "complete" && r.status !== "cancelled",
		);
		if (active.length > 0) return failure(activeGoalMessage(active[0]!.id), SOURCE);

		const lock = await this.deps.store.acquire();
		if (!lock.ok) {
			return failure(`cannot lock the goal record directory: ${lock.error}`, SOURCE);
		}
		return lock;
	}
}
