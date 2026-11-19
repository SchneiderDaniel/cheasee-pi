// ─── Goal control: steering, revision, stop, resume, cleanup ────
// The user-facing controls of a running goal. Steering appends to the record
// without touching criteria (R4.AC4); revision re-opens clarification; stop
// aborts the live generation and starts nothing else (R7.AC2); cleanup removes
// the worktree only on explicit confirmation (R3.AC5).

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import { transitionTo, type AcceptanceCriterion, type GoalRecord } from "../domain/goal-record.ts";
import { appendSteering, reviseCriteria } from "../domain/steering.ts";
import { buildGenerationPrompt } from "./goal-prompts.ts";
import { pauseForUser } from "./goal-launch.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { GoalAgentRuntime, GoalStore, LoadGoalConfig } from "./ports.ts";

const SOURCE = "goal-loop";

/** Ports the controls need. */
export interface GoalControlDeps {
	runtime: GoalAgentRuntime;
	store: GoalStore;
	loadConfig: LoadGoalConfig;
	notify?: NotifyFn;
}

/** Steering, revision, stop, resume and cleanup. */
export class GoalControl {
	private readonly keeper: RecordKeeper;
	private readonly deps: GoalControlDeps;

	constructor(keeper: RecordKeeper, deps: GoalControlDeps) {
		this.keeper = keeper;
		this.deps = deps;
	}

	/** Ordinary message during an active goal: steer, never rewrite criteria. */
	async steer(message: string): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record || !this.keeper.hasActiveGoal()) return failure("no active goal to steer", SOURCE);
		const steered = appendSteering(record, message);
		if (steered === record) return { ok: true, value: record };
		const persisted = await this.keeper.persistOrPause(steered);
		if (!persisted.ok) return persisted;
		const forwarded = await this.deps.runtime.steer(message);
		if (!forwarded.ok) {
			return failure(`could not forward steering message: ${forwarded.error}`, SOURCE);
		}
		return persisted;
	}

	/**
	 * Record an ordinary user message while the goal is `clarifying`.
	 *
	 * The message is clarification input, not a criterion change: it is appended
	 * to the record so a context reset cannot lose the user's answer (R2.AC3).
	 */
	async recordClarificationMessage(message: string): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no goal is being clarified", SOURCE);
		if (record.status !== "clarifying") {
			return failure(`goal ${record.id} is not clarifying`, SOURCE);
		}
		return await this.keeper.persistOrPause(appendSteering(record, message));
	}

	/** `/goal revise`: replace criteria and re-enter clarification. */
	async revise(input: {
		criteria: AcceptanceCriterion[];
		clarifiedGoal?: string;
	}): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no goal to revise", SOURCE);
		let revised: GoalRecord;
		try {
			revised = reviseCriteria(record, input.criteria, input.clarifiedGoal);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), SOURCE);
		}
		this.keeper.setNextAction("re-clarify the revised goal");
		return await this.keeper.persistOrPause(revised);
	}

	/**
	 * `/goal stop` (R1.AC4, R7.AC2): abort the running generation, save the
	 * final status, and start nothing else.
	 */
	async stop(): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no goal is running", SOURCE);
		if (!this.keeper.hasActiveGoal()) {
			return failure(`goal ${record.id} is already ${record.status}`, SOURCE);
		}
		const aborted = await this.deps.runtime.abort();
		if (!aborted.ok) {
			this.deps.notify?.error(`could not abort the running session: ${aborted.error}`);
		}
		const cancelled: GoalRecord = { ...transitionTo(record, "cancelled"), inFlight: false };
		this.keeper.setNextAction("");
		const persisted = await this.keeper.persistOrPause(cancelled);
		await this.deps.runtime.dispose();
		await this.deps.store.release();
		return persisted;
	}

	/** `/goal resume [--approve]`: un-pause and start the next generation. */
	async resume(input: { approve: boolean }): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no goal to resume", SOURCE);
		if (record.status !== "paused") {
			return failure(`goal ${record.id} is ${record.status}, not paused`, SOURCE);
		}
		if (!input.approve) return failure(refusalMessage(record), SOURCE);

		const config = this.deps.loadConfig();
		if (!config.ok) return failure(`cannot resume goal: ${config.error}`, SOURCE);
		const resumed: GoalRecord = {
			...transitionTo(record, "active"),
			blocker: null,
			config: {
				model: config.value.settings.model,
				rolloverTokens: config.value.settings.contextRolloverTokens,
				maxIterations: config.value.settings.maxIterations,
			},
		};
		this.keeper.setNextAction(resumed.nextAction || "continue the goal");
		const persisted = await this.keeper.persistOrPause(resumed);
		if (!persisted.ok) return persisted;
		return await this.startNextGeneration(resumed);
	}

	/** Start the resumed generation; a launch failure pauses for direction. */
	private async startNextGeneration(record: GoalRecord): Promise<Result<GoalRecord>> {
		const started = await this.deps.runtime.start({
			goalId: record.id,
			worktree: record.worktree ?? "",
			model: record.config.model,
			prompt: buildGenerationPrompt(record),
			generation: record.generation,
		});
		if (started.ok) return { ok: true, value: record };
		const blocker = `fresh session could not start: ${started.error}`;
		return await pauseForUser(this.keeper, this.deps.notify, record, blocker);
	}
}

/** The `/goal resume` approval prompt. */
function refusalMessage(record: GoalRecord): string {
	const blocker = record.blocker ?? "unknown blocker";
	return `goal ${record.id} is paused (${blocker}) — run /goal resume --approve to continue`;
}
