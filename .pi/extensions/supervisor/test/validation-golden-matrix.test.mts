/**
 * Characterization oracle: validation.ts golden-master matrix and quirk
 * locks (#1548).
 *
 * Full-array equality on { valid, errors } — byte-exact strings AND push
 * order. The expectation values were generated from pre-refactor code;
 * guard-clause extraction must preserve them (#1548 principle 1).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/validation-golden-matrix.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAgentOutput } from "../agent/validation.ts";

// ─── Golden-master characterization matrix (#1548) ─────────────────────
// Full-array equality on { valid, errors } — byte-exact strings AND push
// order. Expectation values below were generated from pre-refactor code;
// guard-clause extraction must preserve them (issue #1548 principle 1).

const base = { action: "COMPLETE", agentName: "a" };
const EXCEED = "'auditScore.passing' (-1) cannot exceed 'auditScore.total' (-2)";

describe("validateAgentOutput — golden-master matrix (characterization)", () => {
	const rows: [string, Record<string, unknown>, { valid: boolean; errors: string[] }][] = [
		[
			"dual-negative auditScore co-fires both errors in fixed order",
			{ ...base, auditScore: { passing: -1, total: -2 } },
			{
				valid: false,
				errors: ["'auditScore.passing' and 'auditScore.total' must be non-negative", EXCEED],
			},
		],
		[
			"NaN passing passes (typeof number quirk)",
			{ ...base, auditScore: { passing: NaN, total: 5 } },
			{ valid: true, errors: [] },
		],
		[
			"auditScore null passes (helper keeps internal guard)",
			{ ...base, auditScore: null },
			{ valid: true, errors: [] },
		],
		["findings null passes", { ...base, findings: null }, { valid: true, errors: [] }],
		[
			"zero-zero auditScore passes (type checks, not truthiness)",
			{ ...base, auditScore: { passing: 0, total: 0 } },
			{ valid: true, errors: [] },
		],
		[
			"passing === total is valid (equality boundary)",
			{ ...base, auditScore: { passing: 3, total: 3 } },
			{ valid: true, errors: [] },
		],
		[
			"passing > total pushes only cannot-exceed",
			{ ...base, auditScore: { passing: 5, total: 3 } },
			{ valid: false, errors: ["'auditScore.passing' (5) cannot exceed 'auditScore.total' (3)"] },
		],
		[
			"fractional passing/total valid",
			{ ...base, auditScore: { passing: 1.5, total: 2 } },
			{ valid: true, errors: [] },
		],
		[
			"fractional cannot-exceed interpolates verbatim",
			{ ...base, auditScore: { passing: 2, total: 1.5 } },
			{ valid: false, errors: ["'auditScore.passing' (2) cannot exceed 'auditScore.total' (1.5)"] },
		],
		[
			"string passing → single numbers error",
			{ ...base, auditScore: { passing: "5", total: 5 } },
			{ valid: false, errors: ["'auditScore.passing' and 'auditScore.total' must be numbers"] },
		],
		[
			"missing total → single numbers error",
			{ ...base, auditScore: { passing: 1 } },
			{ valid: false, errors: ["'auditScore.passing' and 'auditScore.total' must be numbers"] },
		],
		[
			"auditScore array → must-be-object error",
			{ ...base, auditScore: [1, 2] },
			{
				valid: false,
				errors: ["'auditScore' must be an object with 'passing' and 'total' fields"],
			},
		],
		[
			"auditScore string → must-be-object error",
			{ ...base, auditScore: "x" },
			{
				valid: false,
				errors: ["'auditScore' must be an object with 'passing' and 'total' fields"],
			},
		],
		[
			"findings 42 → must-be-array error",
			{ ...base, findings: 42 },
			{ valid: false, errors: ["'findings' must be an array if provided"] },
		],
		[
			"findings string → must-be-array error",
			{ ...base, findings: "nope" },
			{ valid: false, errors: ["'findings' must be an array if provided"] },
		],
		[
			"non-object entry 42 → exactly one object error, fields skipped",
			{ ...base, findings: [42] },
			{ valid: false, errors: ["findings[0] must be an object"] },
		],
		[
			"null entry → exactly one object error, fields skipped",
			{ ...base, findings: [null] },
			{ valid: false, errors: ["findings[0] must be an object"] },
		],
		[
			"fully-bad entry pushes 5 errors in canonical order",
			{
				...base,
				findings: [{ severity: "fatal", dimension: 7, symptom: "  ", consequence: 0, remedy: "" }],
			},
			{
				valid: false,
				errors: [
					"findings[0].severity must be one of: critical, warning, suggestion",
					"findings[0].dimension must be a string",
					"findings[0].symptom is required and must be a non-empty string",
					"findings[0].consequence is required and must be a non-empty string",
					"findings[0].remedy is required and must be a non-empty string",
				],
			},
		],
		[
			"bare entry (severity only) → 4 errors without severity error",
			{ ...base, findings: [{ severity: "warning" }] },
			{
				valid: false,
				errors: [
					"findings[0].dimension must be a string",
					"findings[0].symptom is required and must be a non-empty string",
					"findings[0].consequence is required and must be a non-empty string",
					"findings[0].remedy is required and must be a non-empty string",
				],
			},
		],
		[
			"non-string location → per-index location error",
			{
				...base,
				findings: [
					{
						severity: "warning",
						dimension: "d",
						symptom: "s",
						consequence: "c",
						remedy: "r",
						location: 42,
					},
				],
			},
			{ valid: false, errors: ["findings[0].location must be a string if provided"] },
		],
		[
			"null location valid",
			{
				...base,
				findings: [
					{
						severity: "warning",
						dimension: "d",
						symptom: "s",
						consequence: "c",
						remedy: "r",
						location: null,
					},
				],
			},
			{ valid: true, errors: [] },
		],
		[
			"omitted location valid",
			{
				...base,
				findings: [
					{ severity: "warning", dimension: "d", symptom: "s", consequence: "c", remedy: "r" },
				],
			},
			{ valid: true, errors: [] },
		],
		[
			"multi-index array: index interpolation and valid-entry skip",
			{
				...base,
				findings: [
					"x",
					{ severity: "critical", dimension: "d", symptom: "s", consequence: "c", remedy: "r" },
					{ severity: "nope", dimension: "d2", symptom: "", consequence: "c2", remedy: "r2" },
				],
			},
			{
				valid: false,
				errors: [
					"findings[0] must be an object",
					"findings[2].severity must be one of: critical, warning, suggestion",
					"findings[2].symptom is required and must be a non-empty string",
				],
			},
		],
		[
			"union row pins helper call order scalar → auditScore → findings",
			{
				action: "COMPLETE",
				agentName: null,
				auditScore: { passing: -2, total: -1 },
				findings: [{ severity: "ok", dimension: "d", symptom: "s", consequence: "c", remedy: "r" }],
			},
			{
				valid: false,
				errors: [
					"Missing required field: 'agentName'",
					"'auditScore.passing' and 'auditScore.total' must be non-negative",
					"findings[0].severity must be one of: critical, warning, suggestion",
				],
			},
		],
	];

	for (const [name, data, expected] of rows) {
		it(name, () => {
			assert.deepEqual(validateAgentOutput(data), expected);
		});
	}
});

// ─── Named quirk locks (#1548 Phase 2) ─────────────────────────────────
// Each non-obvious behavior gets its own name so future strictness
// changes can find and (deliberately) break them.

describe("validateAgentOutput — quirk locks", () => {
	it("dual-error co-fire: negative passing AND passing>total push two errors, never else-if", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: { passing: -1, total: -2 } }), {
			valid: false,
			errors: ["'auditScore.passing' and 'auditScore.total' must be non-negative", EXCEED],
		});
	});

	it("NaN passing passes because typeof NaN === 'number' and NaN comparisons are false", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: { passing: NaN, total: 5 } }), {
			valid: true,
			errors: [],
		});
	});

	it("auditScore:null and findings:null pass with zero errors", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: null }), {
			valid: true,
			errors: [],
		});
		assert.deepEqual(validateAgentOutput({ ...base, findings: null }), { valid: true, errors: [] });
	});

	it("zero-zero auditScore passes — validation is type-based, not truthiness", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: { passing: 0, total: 0 } }), {
			valid: true,
			errors: [],
		});
	});

	it("passing === total is valid (> not >=)", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: { passing: 3, total: 3 } }), {
			valid: true,
			errors: [],
		});
	});

	it("continue-skip: non-object entry skips remaining field checks for that entry only", () => {
		assert.deepEqual(
			validateAgentOutput({
				...base,
				findings: [
					null,
					{ severity: "bad", dimension: "d", symptom: "s", consequence: "c", remedy: "r" },
				],
			}),
			{
				valid: false,
				errors: [
					"findings[0] must be an object",
					"findings[1].severity must be one of: critical, warning, suggestion",
				],
			},
		);
	});
});
