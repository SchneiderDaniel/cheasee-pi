// ─── Phase 2: acceptance-criteria validity ───────────────────────
// R1.AC2: a goal cannot start until every criterion has a verification method,
// and R4.AC4: steering never rewrites criteria.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	boundQuestions,
	criterionProblem,
	goalReadiness,
	isGoalReady,
	MAX_CLARIFICATION_QUESTIONS,
	verifierProblem,
} from "../domain/criteria.ts";
import { appendSteering, reviseCriteria } from "../domain/steering.ts";
import type { AcceptanceCriterion } from "../domain/goal-record.ts";
import { buildRecord } from "./helpers/builders.mts";

const commandCriterion = (): AcceptanceCriterion => ({
	id: "c1",
	text: "tests pass",
	verifier: { kind: "command", argv: ["npm", "test"], pinned: [], expectExit: 0 },
});

const inspectCriterion = (): AcceptanceCriterion => ({
	id: "c2",
	text: "diff reviewed",
	verifier: { kind: "inspect", instruction: "the diff adds a test" },
});

describe("criterion validity", () => {
	it("rejects a criterion with neither a command nor an inspect verifier", () => {
		const broken = { id: "c9", text: "vibes" } as unknown as AcceptanceCriterion;
		const problem = criterionProblem(broken);
		assert.ok(problem);
		assert.match(problem, /c9/);
		assert.match(problem, /no verification method/);
	});

	it("rejects a command verifier with an empty argv", () => {
		const broken: AcceptanceCriterion = {
			id: "c3",
			text: "no command",
			verifier: { kind: "command", argv: [], pinned: [], expectExit: 0 },
		};
		assert.match(criterionProblem(broken) ?? "", /c3.*empty argv/);
	});

	it("defaults expectExit to 0 and honours a non-zero expectation", () => {
		const zero = commandCriterion();
		assert.equal(verifierProblem(zero.verifier), null);
		const nonZero: AcceptanceCriterion = {
			id: "c4",
			text: "fails as expected",
			verifier: { kind: "command", argv: ["false"], pinned: [], expectExit: 1 },
		};
		assert.equal(criterionProblem(nonZero), null);
	});

	it("rejects an inspect verifier with an empty instruction", () => {
		const broken: AcceptanceCriterion = {
			id: "c5",
			text: "look at it",
			verifier: { kind: "inspect", instruction: "   " },
		};
		assert.match(criterionProblem(broken) ?? "", /c5.*empty instruction/);
	});

	it("rejects a duplicated criterion id", () => {
		const readiness = goalReadiness({
			clarifiedGoal: "do the thing",
			criteria: [commandCriterion(), commandCriterion()],
		});
		assert.equal(readiness.ready, false);
		assert.ok(readiness.problems.some((p) => p.includes("duplicated")));
	});
});

describe("goal readiness", () => {
	it("is not ready without a clarified goal", () => {
		const readiness = goalReadiness({ clarifiedGoal: "  ", criteria: [commandCriterion()] });
		assert.equal(readiness.ready, false);
		assert.match(readiness.problems.join("\n"), /no clarified statement/);
	});

	it("is not ready without criteria", () => {
		const readiness = goalReadiness({ clarifiedGoal: "do the thing", criteria: [] });
		assert.equal(readiness.ready, false);
		assert.match(readiness.problems.join("\n"), /no acceptance criteria/);
	});

	it("is not ready when any criterion is invalid", () => {
		const readiness = goalReadiness({
			clarifiedGoal: "do the thing",
			criteria: [
				commandCriterion(),
				{ id: "c6", text: "broken", verifier: { kind: "inspect", instruction: "" } },
			],
		});
		assert.equal(readiness.ready, false);
		assert.ok(readiness.problems.some((p) => p.includes("c6")));
	});

	it("is ready with a clarified goal and every criterion verifiable", () => {
		assert.equal(
			isGoalReady({
				clarifiedGoal: "do the thing",
				criteria: [commandCriterion(), inspectCriterion()],
			}),
			true,
		);
	});
});

describe("clarification bounds", () => {
	it("bounds the question list to five and drops blanks", () => {
		const questions = boundQuestions(["1", " ", "2", "3", "4", "5", "6", "7"]);
		assert.equal(questions.length, MAX_CLARIFICATION_QUESTIONS);
		assert.deepEqual(questions, ["1", "2", "3", "4", "5"]);
	});
});

describe("steering vs. revision", () => {
	it("appends steering and leaves criteria and clarifiedGoal byte-identical", () => {
		const record = buildRecord({
			status: "active",
			clarifiedGoal: "ship the widget",
			criteria: [commandCriterion()],
		});
		const steered = appendSteering(record, "use the existing helper");
		assert.deepEqual(steered.steering, ["use the existing helper"]);
		assert.deepEqual(steered.criteria, record.criteria);
		assert.equal(steered.clarifiedGoal, record.clarifiedGoal);
	});

	it("ignores an empty steering message", () => {
		const record = buildRecord({ status: "active" });
		assert.equal(appendSteering(record, "   "), record);
	});

	it("changes criteria only through revision, which re-enters clarification", () => {
		const record = buildRecord({ status: "verifying", clarifiedGoal: "ship the widget" });
		const revised = reviseCriteria(record, [inspectCriterion()]);
		assert.equal(revised.status, "clarifying");
		assert.deepEqual(revised.criteria, [inspectCriterion()]);
		assert.deepEqual(revised.verification, []);
	});

	it("refuses to revise a terminal goal", () => {
		const record = buildRecord({ status: "complete" });
		assert.throws(() => reviseCriteria(record, [inspectCriterion()]), /terminal/);
	});
});
