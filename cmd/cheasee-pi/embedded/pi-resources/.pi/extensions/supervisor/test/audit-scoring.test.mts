/**
 * Tests for audit scoring functions in config/workflow.ts
 *
 * Phase 1: Pure function tests — no I/O, no infra.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-scoring.test.mts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	getActiveAuditDimensions,
	computeAuditScoreFromFindings,
	evaluateAuditScoreGate,
} from "../config/workflow.ts";
import type { Finding } from "../config/types.ts";

// ═══════════════════════════════════════════════════════════════════════
// getActiveAuditDimensions
// ═══════════════════════════════════════════════════════════════════════

describe("getActiveAuditDimensions", () => {
	it("researcherSkipped=false returns all 8 KNOWN_AUDIT_DIMENSIONS", () => {
		const dims = getActiveAuditDimensions(false);
		assert.equal(dims.length, 8);
		assert.ok(dims.includes("research-incorporation"));
	});

	it("researcherSkipped=true returns 7 dimensions excluding research-incorporation", () => {
		const dims = getActiveAuditDimensions(true);
		assert.equal(dims.length, 7);
		assert.ok(!dims.includes("research-incorporation"));
	});

	it("researcherSkipped=true still includes all other dimensions", () => {
		const dims = getActiveAuditDimensions(true);
		assert.ok(dims.includes("architecture-compliance"));
		assert.ok(dims.includes("ticket-fulfillment"));
		assert.ok(dims.includes("test-quality"));
		assert.ok(dims.includes("correctness-safety"));
		assert.ok(dims.includes("code-quality"));
		assert.ok(dims.includes("completeness"));
		assert.ok(dims.includes("duplicate-code"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// computeAuditScoreFromFindings
// ═══════════════════════════════════════════════════════════════════════

describe("computeAuditScoreFromFindings", () => {
	it("no findings → all dimensions passing (8/8)", () => {
		const score = computeAuditScoreFromFindings([]);
		assert.equal(score.passing, 8);
		assert.equal(score.total, 8);
	});

	it("no dimensions param (backward compat) uses all 8 known dimensions", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "architecture-compliance",
				symptom: "Bad arch",
				consequence: "Hard to maintain",
				remedy: "Fix it",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		assert.equal(score.total, 8);
		assert.equal(score.passing, 7);
	});

	it("with explicit dimensions list uses that list instead of KNOWN_AUDIT_DIMENSIONS", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "architecture-compliance",
				symptom: "Bad arch",
				consequence: "Hard to maintain",
				remedy: "Fix it",
			},
		];
		const dims = ["architecture-compliance", "test-quality"];
		const score = computeAuditScoreFromFindings(findings, dims);
		assert.equal(score.total, 2);
		assert.equal(score.passing, 1);
	});

	it("critical finding in one dimension fails only that dimension", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "architecture-compliance",
				symptom: "Bad arch",
				consequence: "Hard to maintain",
				remedy: "Fix it",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		assert.equal(score.passing, 7);
		assert.equal(score.total, 8);
	});

	it("multiple critical findings across different dimensions → multiple dimensions failed", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "architecture-compliance",
				symptom: "Bad arch",
				consequence: "Hard to maintain",
				remedy: "Fix it",
			},
			{
				severity: "critical",
				dimension: "test-quality",
				symptom: "No tests",
				consequence: "Bugs",
				remedy: "Add tests",
			},
			{
				severity: "warning",
				dimension: "code-quality",
				symptom: "Lint errors",
				consequence: "Tech debt",
				remedy: "Fix lint",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		assert.equal(score.passing, 5);
		assert.equal(score.total, 8);
	});

	it("warning severity also fails dimension (same as critical)", () => {
		const findings: Finding[] = [
			{
				severity: "warning",
				dimension: "correctness-safety",
				symptom: "Unsafe code",
				consequence: "Security risk",
				remedy: "Add validation",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		assert.equal(score.passing, 7);
		assert.equal(score.total, 8);
	});

	it("suggestion findings do NOT fail any dimension", () => {
		const findings: Finding[] = [
			{
				severity: "suggestion",
				dimension: "architecture-compliance",
				symptom: "Could be better",
				consequence: "Minor",
				remedy: "Improve",
			},
			{
				severity: "suggestion",
				dimension: "code-quality",
				symptom: "Style issue",
				consequence: "Readability",
				remedy: "Refactor",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		// Suggestions don't fail any dimension
		assert.equal(score.passing, 8);
		assert.equal(score.total, 8);
	});

	it("unknown/custom dimension (e.g. 'tests-passed') does not affect score even with critical severity", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "tests-passed",
				symptom: "Tests failed",
				consequence: "Regression",
				remedy: "Fix tests",
			},
		];
		// 'tests-passed' is not in KNOWN_AUDIT_DIMENSIONS, so it doesn't fail any dimension
		const score = computeAuditScoreFromFindings(findings);
		assert.equal(score.passing, 8);
		assert.equal(score.total, 8);
	});

	it("excludes research-incorporation when active dimensions list excludes it", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "research-incorporation",
				symptom: "Missing research",
				consequence: "Wrong approach",
				remedy: "Research first",
			},
		];
		const dims = getActiveAuditDimensions(true); // researcher skipped
		const score = computeAuditScoreFromFindings(findings, dims);
		// research-incorporation is not in active dimensions, so it doesn't count
		assert.equal(score.total, 7);
		// finding is in research-incorporation which is excluded → all passing
		assert.equal(score.passing, 7);
	});

	it("includes research-incorporation when researcher not skipped", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "research-incorporation",
				symptom: "Missing research",
				consequence: "Wrong approach",
				remedy: "Research first",
			},
		];
		const dims = getActiveAuditDimensions(false); // researcher NOT skipped
		const score = computeAuditScoreFromFindings(findings, dims);
		assert.equal(score.total, 8);
		assert.equal(score.passing, 7);
	});

	it("empty findings with reduced dimensions → full score on reduced total", () => {
		const dims = getActiveAuditDimensions(true); // 7 dimensions
		const score = computeAuditScoreFromFindings([], dims);
		assert.equal(score.passing, 7);
		assert.equal(score.total, 7);
	});

	it("same dimension failed by multiple findings → counted once", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "architecture-compliance",
				symptom: "Bad arch",
				consequence: "Hard to maintain",
				remedy: "Fix it",
			},
			{
				severity: "warning",
				dimension: "architecture-compliance",
				symptom: "More issues",
				consequence: "Worse",
				remedy: "Fix more",
			},
		];
		const score = computeAuditScoreFromFindings(findings);
		// Same dimension failed twice but counted once
		assert.equal(score.passing, 7);
		assert.equal(score.total, 8);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// evaluateAuditScoreGate
// ═══════════════════════════════════════════════════════════════════════

describe("evaluateAuditScoreGate", () => {
	it("score > required → passes=true", () => {
		const result = evaluateAuditScoreGate({ passing: 6, total: 8 }, 0.75);
		assert.equal(result.passes, true);
		assert.equal(result.required, 6); // ceil(8 * 0.75) = 6
	});

	it("score == required → passes=true (boundary)", () => {
		const result = evaluateAuditScoreGate({ passing: 6, total: 8 }, 0.75);
		assert.equal(result.passes, true);
		assert.equal(result.required, 6);
	});

	it("score < required → passes=false", () => {
		const result = evaluateAuditScoreGate({ passing: 5, total: 8 }, 0.75);
		assert.equal(result.passes, false);
		assert.equal(result.required, 6);
	});

	it("score=0 + threshold=0.75 → passes=false, required=ceil(8*0.75)=6", () => {
		const result = evaluateAuditScoreGate({ passing: 0, total: 8 }, 0.75);
		assert.equal(result.passes, false);
		assert.equal(result.required, 6);
	});

	it("threshold=1.0 → only perfect score passes", () => {
		const perfect = evaluateAuditScoreGate({ passing: 8, total: 8 }, 1.0);
		assert.equal(perfect.passes, true);
		assert.equal(perfect.required, 8);

		const imperfect = evaluateAuditScoreGate({ passing: 7, total: 8 }, 1.0);
		assert.equal(imperfect.passes, false);
		assert.equal(imperfect.required, 8);
	});

	it("threshold=0.0 → any score passes", () => {
		const result = evaluateAuditScoreGate({ passing: 0, total: 8 }, 0.0);
		assert.equal(result.passes, true);
		assert.equal(result.required, 0);
	});

	it("returns correct required field", () => {
		const result = evaluateAuditScoreGate({ passing: 4, total: 7 }, 0.75);
		assert.equal(result.required, 6); // ceil(7 * 0.75) = ceil(5.25) = 6
		assert.equal(result.passes, false);
	});

	it("with 7 dimensions (researcher skipped) threshold 0.75 → required=6", () => {
		const result = evaluateAuditScoreGate({ passing: 6, total: 7 }, 0.75);
		assert.equal(result.required, 6); // ceil(7 * 0.75) = ceil(5.25) = 6
		assert.equal(result.passes, true);
	});

	it("with 7 dimensions, score=5 → fails threshold 0.75 (needs 6)", () => {
		const result = evaluateAuditScoreGate({ passing: 5, total: 7 }, 0.75);
		assert.equal(result.required, 6);
		assert.equal(result.passes, false);
	});

	it("handles threshold at 0.5 boundary correctly", () => {
		const result = evaluateAuditScoreGate({ passing: 4, total: 8 }, 0.5);
		assert.equal(result.required, 4); // ceil(8 * 0.5) = 4
		assert.equal(result.passes, true);
	});

	it("handles threshold at 0.51 boundary correctly", () => {
		const result = evaluateAuditScoreGate({ passing: 4, total: 8 }, 0.51);
		assert.equal(result.required, 5); // ceil(8 * 0.51) = ceil(4.08) = 5
		assert.equal(result.passes, false);
	});
});
