// ─── Clarification gate (R1.AC2/AC3) ────────────────────────────
// One round of clarification either keeps the goal open (questions surfaced,
// no worktree, no session) or — once every criterion carries a verifier —
// activates it and starts work with no further confirmation step.

import { failure, type Result } from "../../shared/result.ts";
import { boundQuestions, goalReadiness } from "../domain/criteria.ts";
import { transitionTo, type GoalRecord } from "../domain/goal-record.ts";
import { launchWork } from "./goal-launch.ts";
import type { ClarificationOutcome, ClarificationSubmission, GoalStartDeps } from "./goal-start.ts";
import type { RecordKeeper } from "./record-keeper.ts";

const SOURCE = "goal-loop";

/** The unreachable goal refusal prepended to the readiness problems. */
const UNREACHABLE = "the goal is not reachable with the available repository and tools";

/**
 * The clarification gate.
 *
 * A goal that is unclear, unreachable or unverifiable stays `clarifying`: the
 * bounded questions are recorded and surfaced, and nothing outside the record
 * exists yet (R1.AC2). A ready goal activates and launches immediately
 * (R1.AC3).
 */
export class GoalClarifier {
	private readonly keeper: RecordKeeper;
	private readonly deps: GoalStartDeps;

	constructor(keeper: RecordKeeper, deps: GoalStartDeps) {
		this.keeper = keeper;
		this.deps = deps;
	}

	/** Apply one clarification round; see the class contract. */
	async clarify(input: ClarificationSubmission): Promise<Result<ClarificationOutcome>> {
		const record = this.keeper.current();
		if (!record) return failure("no goal is being clarified", SOURCE);
		if (record.status !== "clarifying") {
			return failure(`goal ${record.id} is not clarifying (status: ${record.status})`, SOURCE);
		}

		const questions = boundQuestions(input.questions ?? []);
		const clarifiedGoal = (input.clarifiedGoal ?? record.clarifiedGoal).trim();
		const criteria = input.criteria ?? record.criteria;
		const candidate: GoalRecord = { ...record, clarifiedGoal, criteria };

		const readiness = goalReadiness(candidate);
		const blocked = input.ready === false || input.reachable === false || !readiness.ready;
		if (blocked) {
			return await this.holdForClarification(
				candidate,
				input.reachable === false,
				questions,
				readiness,
			);
		}

		// Ready: activate, then worktree, then first generation — no prompt in
		// between (R1.AC3).
		const activated = transitionTo(candidate, "active");
		this.keeper.setNextAction("start the first work iteration");
		const activePersisted = await this.keeper.persist(activated);
		if (!activePersisted.ok) return activePersisted;

		const launched = await launchWork({
			keeper: this.keeper,
			deps: this.deps,
			record: activePersisted.value,
		});
		if (!launched.ok) return launched;
		return {
			ok: true,
			value: {
				record: launched.value.record,
				questions: launched.value.started ? [] : questions,
				started: launched.value.started,
			},
		};
	}

	/** Persist the open questions and stay in `clarifying` (R1.AC2). */
	private async holdForClarification(
		candidate: GoalRecord,
		unreachable: boolean,
		questions: string[],
		readiness: { problems: string[] },
	): Promise<Result<ClarificationOutcome>> {
		const problems = unreachable ? [UNREACHABLE, ...readiness.problems] : readiness.problems;
		const persisted = await this.keeper.persist({
			...candidate,
			nextAction: problems[0] ?? questions[0] ?? "answer the clarification questions",
		});
		if (!persisted.ok) return persisted;
		const surfaced = questions.length > 0 ? questions : problems;
		return { ok: true, value: { record: persisted.value, questions: surfaced, started: false } };
	}
}
