// ─── Acceptance criteria validity ────────────────────────────────
// R1.AC1/AC2: a goal is only startable once it has a clarified statement plus
// criteria that each carry a verification method. Pure — the service decides
// what to do with the verdict; this module only judges it.

import type { AcceptanceCriterion, Verifier } from "./goal-record.ts";

/** Maximum focused clarification questions per invocation (research finding). */
export const MAX_CLARIFICATION_QUESTIONS = 5;

/** Why a verifier is unusable, or null when it is valid. */
export function verifierProblem(verifier: Verifier | undefined): string | null {
	if (!verifier) return "has no verification method";
	if (verifier.kind === "command") {
		if (!Array.isArray(verifier.argv) || verifier.argv.length === 0) {
			return "has a command verifier: empty argv";
		}
		if (!Number.isInteger(verifier.expectExit)) {
			return "has a command verifier: expectExit is not an integer";
		}
		for (const pinned of verifier.pinned) {
			if (!pinned.path || !pinned.sha256) return "has a pinned file missing a path or sha256";
		}
		return null;
	}
	if (verifier.kind === "inspect") {
		if (!verifier.instruction || !verifier.instruction.trim()) {
			return "has an inspect verifier: empty instruction";
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
 * plus a valid verifier on every criterion. No confirmation step follows this
 * verdict: readiness IS the gate.
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
