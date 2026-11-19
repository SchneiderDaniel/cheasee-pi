// ─── Steering and revision ───────────────────────────────────────
// R4.AC4: an ordinary message steers the running goal, while the acceptance
// criteria change only through an explicit revision — which re-opens the goal
// for clarification so a revised goal is judged again for clarity and
// verifiability. Pure.

import { transitionTo, type AcceptanceCriterion, type GoalRecord } from "./goal-record.ts";

/**
 * Append a steering message (R4.AC4). `criteria` and `clarifiedGoal` are
 * returned byte-identical — only a revision may change them.
 */
export function appendSteering(record: GoalRecord, message: string): GoalRecord {
	const text = message.trim();
	if (!text) return record;
	return { ...record, steering: [...record.steering, text] };
}

/**
 * Replace the criteria and re-enter clarification (R4.AC4).
 *
 * Routed through the transition table so a terminal goal cannot be revived by
 * revising it.
 */
export function reviseCriteria(
	record: GoalRecord,
	criteria: AcceptanceCriterion[],
	clarifiedGoal?: string,
): GoalRecord {
	return {
		...transitionTo(record, "clarifying"),
		criteria,
		clarifiedGoal: clarifiedGoal ?? record.clarifiedGoal,
		verification: [],
	};
}
