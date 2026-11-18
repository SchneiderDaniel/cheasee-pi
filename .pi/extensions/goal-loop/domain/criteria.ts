// ─── Acceptance criteria validity ────────────────────────────────
// R1.AC1/AC2: a goal is only startable when it has a clarified statement and
// every criterion carries a verification method. Pure — the service decides
// what to do with the verdict; this module only judges it.

import { transitionTo } from "./goal-record.ts";
import type { AcceptanceCriterion, GoalRecord, Verifier } from "./goal-record.ts";

/** Maximum focused clarification questions per invocation (research finding). */
export const MAX_CLARIFICATION_QUESTIONS = 5;

/** Why a verifier is unusable, or null when it is valid. */
export function verifierProblem(verifier: Verifier | undefined): string | null {
	if (!verifier) return "has no verification method";
	if (verifier.kind === "command") {
		if (!Array.isArray(verifier.argv) || verifier.argv.length === 0) {
			return "has a command verifier with an empty argv";
		}
		if (!Number.isInteger(verifier.expectExit)) {
			return "has a command verifier with a non-integer expectExit";
		}
		if (verifier.pinned.some((p) => !p.path || !p.sha256)) {
			return "has a pinned file without a path or sha256";
		}
		return null;
	}
	if (verifier.kind === "inspect") {
		if (!verifier.instruction || !verifier.instruction.trim()) {
			return "has an inspect verifier with an empty instruction";
		}
		return null;
	}
	return `has an unknown verifier kind "${String((verifier as { kind?: unknown }).kind)}"`;
}

/**
 * Why a criterion cannot be verified, or null when it is valid.
 * The message names the criterion id so clarification can quote it back.
 */
export function criterionProblem(criterion: AcceptanceCriterion): string | null {
	if (!criterion.id || !criterion.id.trim()) {
		return `criterion "${criterion.text}" has no id`;
	}
	if (!criterion.text || !criterion.text.trim()) {
		return `criterion "${criterion.id}" has no text`;
	}
	const problem = verifierProblem(criterion.verifier);
	return problem === null ? null : `criterion "${criterion.id}" ${problem}`;
}

/** Every criterion problem, in declaration order. */
export function criterionProblems(criteria: AcceptanceCriterion[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const criterion of criteria) {
		const problem = criterionProblem(criterion);
		if (problem) problems.push(problem);
		if (seen.has(criterion.id)) problems.push(`criterion id "${criterion.id}" is duplicated`);
		seen.add(criterion.id);
	}
	return problems;
}

/**
 * Readiness verdict for starting goal work (R1.AC2/AC3).
 *
 * A goal is ready when it has a clarified statement, at least one criterion,
 * and every criterion has a valid verifier. No further confirmation step
 * exists after this — readiness IS the gate.
 */
export function goalReadiness(record: { clarifiedGoal: string; criteria: AcceptanceCriterion[] }): {
	ready: boolean;
	problems: string[];
} {
	const problems: string[] = [];
	if (!record.clarifiedGoal.trim()) {
		problems.push("the goal has no clarified statement");
	}
	if (record.criteria.length === 0) {
		problems.push("the goal has no acceptance criteria");
	}
	problems.push(...criterionProblems(record.criteria));
	return { ready: problems.length === 0, problems };
}

/** Convenience predicate over {@link goalReadiness}. */
export function isGoalReady(record: {
	clarifiedGoal: string;
	criteria: AcceptanceCriterion[];
}): boolean {
	return goalReadiness(record).ready;
}

/**
 * Bound clarification output to {@link MAX_CLARIFICATION_QUESTIONS}. Blank
 * entries are dropped; order is preserved so the most important question stays
 * first.
 */
export function boundQuestions(questions: string[]): string[] {
	return questions
		.map((q) => q.trim())
		.filter((q) => q !== "")
		.slice(0, MAX_CLARIFICATION_QUESTIONS);
}

/**
 * Append a steering message (R4.AC4). `criteria` and `clarifiedGoal` are
 * returned byte-identical — only `/goal revise` may change them.
 */
export function appendSteering(record: GoalRecord, message: string): GoalRecord {
	const text = message.trim();
	if (!text) return record;
	return { ...record, steering: [...record.steering, text] };
}

/**
 * Replace the criteria and re-enter clarification (R4.AC4): a revised goal must
 * be re-judged for clarity and verifiability before work resumes.
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
