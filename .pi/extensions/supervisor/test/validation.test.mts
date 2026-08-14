/**
 * Entity tests: validation.ts (extracted from output.ts in #1535).
 *
 * Schema validation for parsed agent output, moved verbatim. Return
 * contracts (valid + errors array) are preserved; full regression runs
 * through parseAgentOutput in agent-output.test.mts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAgentOutput, VALID_SEVERITIES } from "../agent/validation.ts";

const completeRecord = {
	action: "COMPLETE",
	agentName: "developer",
	commentBody: "done",
	findings: [
		{ severity: "critical", dimension: "d1", symptom: "s", consequence: "c", remedy: "r" },
		{ severity: "warning", dimension: "d2", symptom: "s", consequence: "c", remedy: "r" },
		{ severity: "suggestion", dimension: "d3", symptom: "s", consequence: "c", remedy: "r" },
	],
};

describe("validateAgentOutput — valid records", () => {
	it("accepts complete record with every severity", () => {
		assert.deepEqual(validateAgentOutput(completeRecord), { valid: true, errors: [] });
	});

	it("accepts each action enum value", () => {
		for (const action of ["COMPLETE", "APPROVED", "REJECTED"]) {
			const result = validateAgentOutput({ ...completeRecord, action });
			assert.equal(result.valid, true, `action ${action} must be valid`);
		}
	});

	it("accepts empty findings array (boundary)", () => {
		const result = validateAgentOutput({ action: "COMPLETE", agentName: "a", findings: [] });
		assert.deepEqual(result, { valid: true, errors: [] });
	});
});

describe("validateAgentOutput — required fields", () => {
	it("rejects missing action", () => {
		const { valid, errors } = validateAgentOutput({ agentName: "a" });
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("'action'")));
	});

	it("rejects missing agentName", () => {
		const { valid, errors } = validateAgentOutput({ action: "COMPLETE" });
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("'agentName'")));
	});

	it("rejects action outside the enum", () => {
		const { valid, errors } = validateAgentOutput({ action: "MAYBE", agentName: "a" });
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("COMPLETE, APPROVED, REJECTED")));
	});
});

describe("validateAgentOutput — refusal and auditScore", () => {
	it("rejects non-empty refusal", () => {
		const { valid, errors } = validateAgentOutput({
			action: "COMPLETE",
			agentName: "a",
			refusal: "I cannot do that",
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("Agent refused")));
	});

	it("rejects auditScore.passing > total", () => {
		const { valid, errors } = validateAgentOutput({
			action: "APPROVED",
			agentName: "a",
			auditScore: { passing: 5, total: 3 },
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("cannot exceed")));
	});

	it("rejects negative passing or total", () => {
		for (const score of [
			{ passing: -1, total: 3 },
			{ passing: 1, total: -3 },
		]) {
			const { valid, errors } = validateAgentOutput({
				action: "APPROVED",
				agentName: "a",
				auditScore: score,
			});
			assert.equal(valid, false);
			assert.ok(errors.some((e) => e.includes("non-negative")));
		}
	});
});

describe("validateAgentOutput — findings entries", () => {
	it("rejects unknown severity with per-index error", () => {
		const { valid, errors } = validateAgentOutput({
			action: "APPROVED",
			agentName: "a",
			findings: [
				{ severity: "fatal", dimension: "d", symptom: "s", consequence: "c", remedy: "r" },
			],
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("findings[0].severity")));
	});

	it("rejects empty symptom", () => {
		const { valid, errors } = validateAgentOutput({
			action: "APPROVED",
			agentName: "a",
			findings: [
				{ severity: "warning", dimension: "d", symptom: "  ", consequence: "c", remedy: "r" },
			],
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("findings[0].symptom")));
	});

	it("rejects non-string remedy", () => {
		const { valid, errors } = validateAgentOutput({
			action: "APPROVED",
			agentName: "a",
			findings: [
				{ severity: "warning", dimension: "d", symptom: "s", consequence: "c", remedy: 42 },
			],
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("findings[0].remedy")));
	});

	it("rejects non-array findings", () => {
		const { valid, errors } = validateAgentOutput({
			action: "APPROVED",
			agentName: "a",
			findings: "not-an-array",
		});
		assert.equal(valid, false);
		assert.ok(errors.some((e) => e.includes("'findings' must be an array")));
	});

	it("VALID_SEVERITIES matches the audit severity enum", () => {
		assert.deepEqual(Array.from(VALID_SEVERITIES).sort(), ["critical", "suggestion", "warning"]);
	});
});
