// Phase 2 — verdict parsing and the BAD gate. A test may only be labelled BAD
// when the evidence carries the whole gate: confidence, a verbatim in-range
// quote, and a BAD-qualifying criterion. Everything else stays PENDING.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	BAD_QUALIFYING_CRITERIA,
	CRITERIA_IDS,
	parseVerdict,
	verdictTargetFor,
} from "../lib/decision.ts";
import type { Verdict } from "../lib/types.ts";

const SOURCE_LINES = [
	'it("adds numbers", () => {',
	"\tconst total = 1 + 1;",
	"\tassert.equal(total, 2);",
	"});",
];

const TARGET = {
	startLine: 1,
	endLine: SOURCE_LINES.length,
	text: SOURCE_LINES.join("\n"),
};

const CFG = { badConfidenceThreshold: 0.8 };

function raw(payload: Record<string, unknown>): string {
	return JSON.stringify(payload);
}

const GOOD_PAYLOAD = {
	decision: "GOOD",
	confidence: 0.93,
	criteria: ["C1", "C2"],
	reason: "asserts project-owned addition behaviour",
	evidence: [{ line: 3, quote: "\tassert.equal(total, 2);" }],
};

const BAD_PAYLOAD = {
	decision: "BAD",
	confidence: 0.9,
	criteria: ["C1"],
	reason: "assertion only restates the literal it was given",
	evidence: [{ line: 3, quote: "\tassert.equal(total, 2);" }],
};

describe("decision: verdict parsing and the BAD gate", () => {
	it("accepts a well-formed GOOD verdict and preserves its fields", () => {
		const verdict = parseVerdict(raw(GOOD_PAYLOAD), TARGET, CRITERIA_IDS, CFG);

		assert.equal(verdict.decision, "GOOD");
		assert.equal(verdict.confidence, 0.93);
		assert.deepEqual(verdict.criteria, ["C1", "C2"]);
		assert.equal(verdict.reason, GOOD_PAYLOAD.reason);
		assert.deepEqual(verdict.evidence, GOOD_PAYLOAD.evidence);
	});

	it("accepts BAD when every gate condition holds", () => {
		const verdict = parseVerdict(raw(BAD_PAYLOAD), TARGET, CRITERIA_IDS, CFG);

		assert.equal(verdict.decision, "BAD");
		assert.deepEqual(verdict.criteria, ["C1"]);
	});

	it("treats the confidence threshold as inclusive", () => {
		const atThreshold = parseVerdict(
			raw({ ...BAD_PAYLOAD, confidence: 0.8 }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(atThreshold.decision, "BAD");
	});

	it("keeps a below-threshold BAD as PENDING", () => {
		const verdict = parseVerdict(
			raw({ ...BAD_PAYLOAD, confidence: 0.79 }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);

		assert.equal(verdict.decision, "PENDING");
		assert.match(verdict.pendingReason, /confidence/);
	});

	it("rejects an evidence quote that differs by a single indentation space", () => {
		const verdict = parseVerdict(
			raw({ ...BAD_PAYLOAD, evidence: [{ line: 3, quote: "\t assert.equal(total, 2);" }] }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);

		assert.equal(verdict.decision, "PENDING");
		assert.match(verdict.pendingReason, /evidence/);
	});

	it("accepts an exact multi-line quote and rejects a re-wrapped one", () => {
		const exact = parseVerdict(
			raw({
				...BAD_PAYLOAD,
				evidence: [{ line: 2, quote: "\tconst total = 1 + 1;\n\tassert.equal(total, 2);" }],
			}),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(exact.decision, "BAD");

		const wrapped = parseVerdict(
			raw({
				...BAD_PAYLOAD,
				evidence: [{ line: 2, quote: "\tconst total = 1 + 1;\nassert.equal(total, 2);" }],
			}),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(wrapped.decision, "PENDING");
	});

	it("rejects a quote that only exists outside the judged slice", () => {
		const verdict = parseVerdict(
			raw({ ...BAD_PAYLOAD, evidence: [{ line: 3, quote: '\tit("other", () => {});' }] }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);

		assert.equal(verdict.decision, "PENDING");
	});

	it("rejects BAD without evidence", () => {
		const verdict = parseVerdict(raw({ ...BAD_PAYLOAD, evidence: [] }), TARGET, CRITERIA_IDS, CFG);

		assert.equal(verdict.decision, "PENDING");
		assert.match(verdict.pendingReason, /evidence/);
	});

	it("rejects evidence lines outside the judged range", () => {
		for (const line of [0, TARGET.endLine + 1]) {
			const verdict = parseVerdict(
				raw({ ...BAD_PAYLOAD, evidence: [{ line, quote: "\tassert.equal(total, 2);" }] }),
				TARGET,
				CRITERIA_IDS,
				CFG,
			);
			assert.equal(verdict.decision, "PENDING", `line ${line} must be rejected`);
		}
	});

	it("requires a BAD-qualifying criterion", () => {
		for (const criteria of [["C4"], ["C5"], ["C6"], ["C7"], ["C4", "C6"]]) {
			const verdict = parseVerdict(raw({ ...BAD_PAYLOAD, criteria }), TARGET, CRITERIA_IDS, CFG);
			assert.equal(verdict.decision, "PENDING", `criteria ${criteria.join(",")} must not qualify`);
		}

		const qualified = parseVerdict(
			raw({ ...BAD_PAYLOAD, criteria: ["C3", "C4"] }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(qualified.decision, "BAD");
		assert.deepEqual(qualified.criteria, ["C3", "C4"]);
		assert.equal(BAD_QUALIFYING_CRITERIA.has("C3"), true);
	});

	it("rejects unknown criterion ids and empty criterion lists", () => {
		const unknown = parseVerdict(
			raw({ ...BAD_PAYLOAD, criteria: ["C8"] }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(unknown.decision, "PENDING");

		const emptyGood = parseVerdict(
			raw({ ...GOOD_PAYLOAD, criteria: [] }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);
		assert.equal(emptyGood.decision, "PENDING");
	});

	it("maps AMBIGUOUS to PENDING", () => {
		const verdict = parseVerdict(
			raw({ ...GOOD_PAYLOAD, decision: "AMBIGUOUS" }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);

		assert.equal(verdict.decision, "PENDING");
		assert.match(verdict.pendingReason, /ambiguous/i);
	});

	it("maps malformed and non-object payloads to PENDING", () => {
		const payloads = [
			"{not json",
			'the verdict is:\n```json\n{"decision":"GOOD"}\n```',
			"null",
			"[]",
		];
		for (const payload of payloads) {
			const verdict = parseVerdict(payload, TARGET, CRITERIA_IDS, CFG);
			assert.equal(verdict.decision, "PENDING", payload);
			assert.match(verdict.pendingReason, /payload|schema/);
		}
	});

	it("rejects missing or non-numeric confidence and missing reason", () => {
		const { confidence: _confidence, ...noConfidence } = BAD_PAYLOAD;
		const { reason: _reason, ...noReason } = BAD_PAYLOAD;

		for (const payload of [noConfidence, { ...BAD_PAYLOAD, confidence: "0.9" }, noReason]) {
			assert.equal(parseVerdict(raw(payload), TARGET, CRITERIA_IDS, CFG).decision, "PENDING");
		}
	});

	it("never fabricates a BAD decision, reason, or evidence for PENDING", () => {
		const verdict = parseVerdict(
			raw({ ...BAD_PAYLOAD, confidence: 0.1 }),
			TARGET,
			CRITERIA_IDS,
			CFG,
		);

		assert.equal(verdict.decision, "PENDING");
		assert.equal(verdict.reason, "");
		assert.deepEqual(verdict.evidence, []);
		assert.deepEqual(verdict.criteria, []);
		assert.equal(verdict.confidence, 0);
		assert.notEqual((verdict as Verdict).decision, "BAD");
	});

	it("is side-effect free: identical input yields deep-equal output", () => {
		const first = parseVerdict(raw(BAD_PAYLOAD), TARGET, CRITERIA_IDS, CFG);
		const second = parseVerdict(raw(BAD_PAYLOAD), TARGET, CRITERIA_IDS, CFG);

		assert.deepEqual(first, second);
	});

	it("builds a target from a definition and the file source", () => {
		const source = ["// header", ...SOURCE_LINES, "// trailer"].join("\n");
		const target = verdictTargetFor({ startLine: 2, endLine: 5 }, source);

		assert.equal(target.text, SOURCE_LINES.join("\n"));
		assert.equal(target.startLine, 2);
		assert.equal(target.endLine, 5);
	});
});
