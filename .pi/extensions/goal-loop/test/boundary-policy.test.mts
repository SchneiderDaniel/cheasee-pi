// ─── Phase 3: boundary policy ────────────────────────────────────
// The ordering contract: complete > blocked > cap > rollover > continue.
// If this file and one of those rules disagree, the loop stops for the wrong
// reason — which is exactly what R5.AC2 and R7.AC1 exist to prevent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	allCriteriaPass,
	decideBoundary,
	describeDecision,
	isVerifiedComplete,
	type BoundaryInput,
} from "../domain/boundary-policy.ts";
import type { VerificationResult } from "../domain/goal-record.ts";

const pass = (id = "c1"): VerificationResult => ({
	criterionId: id,
	result: "pass",
	evidenceRef: "ok",
	checkedAt: "2026-01-02T03:04:05.000Z",
});

const failure = (id = "c1"): VerificationResult => ({
	criterionId: id,
	result: "fail",
	evidenceRef: "nope",
	checkedAt: "2026-01-02T03:04:05.000Z",
});

const base: BoundaryInput = {
	// Incomplete by default: the completion rule is asserted explicitly.
	verification: [failure()],
	prState: "draft",
	tokens: 1_000,
	rolloverTokens: 150_000,
	compactionSeen: false,
	iterations: 1,
	maxIterations: 50,
	blocker: null,
};

const input = (overrides: Partial<BoundaryInput> = {}): BoundaryInput => ({
	...base,
	...overrides,
});

describe("boundary policy ordering", () => {
	it("completes when all criteria pass and a PR exists — even at the cap and threshold", () => {
		const decision = decideBoundary(
			input({
				verification: [pass()],
				iterations: 50,
				maxIterations: 50,
				tokens: 200_000,
				compactionSeen: true,
			}),
		);
		assert.deepEqual(decision, { kind: "complete" });
	});

	it("never completes without a pull request", () => {
		const decision = decideBoundary(input({ verification: [pass()], prState: "none" }));
		assert.deepEqual(decision, { kind: "continue" });
		assert.equal(isVerifiedComplete({ verification: [pass()], prState: "none" }), false);
	});

	it("keeps working through an ordinary failing check", () => {
		const decision = decideBoundary(input({ verification: [failure()] }));
		assert.deepEqual(decision, { kind: "continue" });
	});

	it("treats an empty verification list as incomplete", () => {
		assert.equal(allCriteriaPass([]), false);
		assert.deepEqual(decideBoundary(input({ verification: [] })), { kind: "continue" });
	});

	it("completes despite a blocker once the goal is verified", () => {
		const decision = decideBoundary(input({ verification: [pass()], blocker: "review pending" }));
		assert.deepEqual(decision, { kind: "complete" });
	});

	it("pauses on a blocker while incomplete", () => {
		const decision = decideBoundary(input({ blocker: "no GitHub access" }));
		assert.deepEqual(decision, { kind: "pause", reason: "blocked", detail: "no GitHub access" });
	});

	it("pauses at the cap when incomplete and below the threshold", () => {
		const decision = decideBoundary(input({ iterations: 50 }));
		assert.deepEqual(decision, { kind: "pause-cap" });
	});

	it("checks the cap before the threshold", () => {
		const decision = decideBoundary(input({ iterations: 50, tokens: 500_000 }));
		assert.deepEqual(decision, { kind: "pause-cap" });
	});

	it("rolls over at the threshold", () => {
		assert.deepEqual(decideBoundary(input({ tokens: 150_000 })), { kind: "rollover" });
		assert.deepEqual(decideBoundary(input({ tokens: 150_001 })), { kind: "rollover" });
	});

	it("does not roll over on an unknown token count", () => {
		assert.deepEqual(decideBoundary(input({ tokens: null })), { kind: "continue" });
	});

	it("continues below the threshold", () => {
		assert.deepEqual(decideBoundary(input({ tokens: 149_999 })), { kind: "continue" });
	});

	it("rolls over when an in-place compaction was seen below the threshold", () => {
		assert.deepEqual(decideBoundary(input({ tokens: 1_000, compactionSeen: true })), {
			kind: "rollover",
		});
	});

	it("is pure: the same input twice yields the same decision", () => {
		const twice = input({ iterations: 50 });
		assert.deepEqual(decideBoundary(twice), decideBoundary(twice));
	});

	it("describes every decision kind", () => {
		assert.match(describeDecision({ kind: "complete" }), /^complete/);
		assert.match(
			describeDecision({ kind: "pause", reason: "blocked", detail: "x" }),
			/^pause \(blocked\)/,
		);
		assert.match(describeDecision({ kind: "pause-cap" }), /^pause \(iteration-cap\)/);
		assert.match(describeDecision({ kind: "rollover" }), /^rollover/);
		assert.match(describeDecision({ kind: "continue" }), /^continue/);
	});
});
