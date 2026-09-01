/**
 * Entity tests: validation.ts (extracted from output.ts in #1535).
 *
 * Schema validation for parsed agent output, moved verbatim. Return
 * contracts (valid + errors array) are preserved; full regression runs
 * through parseAgentOutput in agent-output.test.mts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
				errors: [
					"'auditScore.passing' and 'auditScore.total' must be non-negative",
					EXCEED,
				],
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
		[
			"findings null passes",
			{ ...base, findings: null },
			{ valid: true, errors: [] },
		],
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
			{ valid: false, errors: ["'auditScore' must be an object with 'passing' and 'total' fields"] },
		],
		[
			"auditScore string → must-be-object error",
			{ ...base, auditScore: "x" },
			{ valid: false, errors: ["'auditScore' must be an object with 'passing' and 'total' fields"] },
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
			{ ...base, findings: [{ severity: "fatal", dimension: 7, symptom: "  ", consequence: 0, remedy: "" }] },
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
			{ ...base, findings: [{ severity: "warning", dimension: "d", symptom: "s", consequence: "c", remedy: "r", location: 42 }] },
			{ valid: false, errors: ["findings[0].location must be a string if provided"] },
		],
		[
			"null location valid",
			{ ...base, findings: [{ severity: "warning", dimension: "d", symptom: "s", consequence: "c", remedy: "r", location: null }] },
			{ valid: true, errors: [] },
		],
		[
			"omitted location valid",
			{ ...base, findings: [{ severity: "warning", dimension: "d", symptom: "s", consequence: "c", remedy: "r" }] },
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
			errors: [
				"'auditScore.passing' and 'auditScore.total' must be non-negative",
				EXCEED,
			],
		});
	});

	it("NaN passing passes because typeof NaN === 'number' and NaN comparisons are false", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: { passing: NaN, total: 5 } }), {
			valid: true,
			errors: [],
		});
	});

	it("auditScore:null and findings:null pass with zero errors", () => {
		assert.deepEqual(validateAgentOutput({ ...base, auditScore: null }), { valid: true, errors: [] });
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
				findings: [null, { severity: "bad", dimension: "d", symptom: "s", consequence: "c", remedy: "r" }],
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

// ─── White-box structure pin (#1548 Phase 4) ────────────────────────────
// Guards the refactor's shape (issue acceptance criterion: nested blocks
// split into helper functions, each ≤ 2 control-flow nesting levels) via
// source assertions — same precedent as output-facade.test.mts.

describe("validation.ts — refactor structure (#1548)", () => {
	const source = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent/validation.ts"),
		"utf8",
	);

	const HELPER_SIGNATURES = [
		"function validateAuditScore(value: unknown, errors: string[]): void {",
		"function validateFindings(value: unknown, errors: string[]): void {",
		"function validateFinding(item: unknown, index: number, errors: string[]): void {",
	] as const;

	// Strip strings, template literals, and comments so brace counting only
	// sees structural braces (template `${...}` interpolations would inflate it).
	function structuralSource(src: string): string {
		return src
			.replace(/`[^`]*`/g, "")
			.replace(/"(?:\\.|[^\\"])*"/g, "")
			.replace(/'(?:\\.|[^\\'])*'/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
	}

	function functionBody(src: string, signature: string): string {
		const sigIdx = src.indexOf(signature);
		assert.ok(sigIdx >= 0, `${signature} must exist`);
		const open = src.indexOf("{", sigIdx);
		let depth = 0;
		for (let i = open; i < src.length; i++) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") {
				depth--;
				if (depth === 0) return src.slice(open + 1, i);
			}
		}
		assert.fail(`${signature} body never closes`);
	}

	function maxBraceDepth(body: string): number {
		const clean = structuralSource(body);
		let depth = 0;
		let max = 0;
		for (const ch of clean) {
			if (ch === "{") {
				depth++;
				max = Math.max(max, depth);
			} else if (ch === "}") depth--;
		}
		return max;
	}

	it("defines the three per-field helpers module-private with canonical signatures", () => {
		for (const sig of HELPER_SIGNATURES) {
			assert.ok(source.includes(sig), `${sig} must be defined`);
		}
		// Module-private: never listed in any export statement
		assert.ok(source.includes("export { validateAgentOutput, VALID_SEVERITIES };"));
		for (const name of ["validateAuditScore", "validateFindings", "validateFinding"]) {
			assert.ok(
				!new RegExp(`export[^;]*\\b${name}\\b`).test(source),
				`${name} must not be exported`,
			);
		}
	});

	it("each helper body stays ≤ 2 control-flow nesting levels", () => {
		for (const sig of HELPER_SIGNATURES) {
			const depth = maxBraceDepth(functionBody(source, sig));
			assert.ok(depth <= 2, `${sig} nests ${depth} levels deep — must be ≤ 2`);
		}
	});

	it("validateAgentOutput keeps flat scalar checks in order and delegates nested blocks", () => {
		const actionCheck = source.indexOf("Missing required field: 'action'");
		const auditDelegate = source.indexOf("validateAuditScore(data.auditScore, errors);");
		const findingsDelegate = source.indexOf("validateFindings(data.findings, errors);");
		const targetStatusCheck = source.indexOf("'targetStatus' must be a string if provided");
		for (const idx of [actionCheck, auditDelegate, findingsDelegate, targetStatusCheck]) {
			assert.ok(idx >= 0, "expected source marker missing");
		}
		// scalar → auditScore → findings → targetStatus, matching pre-refactor push order
		assert.ok(actionCheck < auditDelegate);
		assert.ok(auditDelegate < findingsDelegate);
		assert.ok(findingsDelegate < targetStatusCheck);
		// orchestrator itself stays flat (≤ 2 levels) after delegation
		const body = functionBody(source, "function validateAgentOutput(data: Record<string, unknown>): ValidationResult {");
		assert.ok(maxBraceDepth(body) <= 2);
	});
});
