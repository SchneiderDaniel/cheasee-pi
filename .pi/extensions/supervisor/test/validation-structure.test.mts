/**
 * White-box structure pin: validation.ts (#1548 Phase 4).
 *
 * Guards the refactor's shape (nested blocks split into helper functions,
 * each ≤ 2 control-flow nesting levels) via source assertions — same
 * precedent as output-facade.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/validation-structure.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── White-box structure pin (#1548 Phase 4) ────────────────────────────
// Guards the refactor's shape (issue acceptance criterion: nested blocks
// split into helper functions, each ≤ 2 control-flow nesting levels) via
// source assertions — same precedent as output-facade.test.mts.

describe("validation.ts — refactor structure (#1548)", () => {
	// The validation groups are their own files since the #2033 split, so the
	// structure pins read every group module instead of the barrel alone.
	const GROUPS = [
		"agent/validation.ts",
		"agent/validation-findings.ts",
		"agent/validation-score.ts",
		"agent/validation-optional.ts",
	];
	const groupSources = GROUPS.map((rel) =>
		readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8"),
	);
	const source = groupSources.join("\n");
	const barrelSource = groupSources[0]!;

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
		// Canonical barrel surface, untouched by the split
		assert.ok(barrelSource.includes("export { validateAgentOutput, VALID_SEVERITIES };"));
		// Not re-exported by the barrel: the groups are internal to validation.ts
		for (const name of ["validateAuditScore", "validateFindings", "validateFinding"]) {
			assert.ok(
				!new RegExp(`export[^;]*\\b${name}\\b`).test(barrelSource),
				`${name} must not be exported from the barrel`,
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
		const targetStatusCheck = source.indexOf(
			'validateOptionalStrings(data, ["targetStatus"], errors);',
		);
		for (const idx of [actionCheck, auditDelegate, findingsDelegate, targetStatusCheck]) {
			assert.ok(idx >= 0, "expected source marker missing");
		}
		// scalar → auditScore → findings → targetStatus, matching pre-refactor push order
		assert.ok(actionCheck < auditDelegate);
		assert.ok(auditDelegate < findingsDelegate);
		assert.ok(findingsDelegate < targetStatusCheck);
		// orchestrator itself stays flat (≤ 2 levels) after delegation
		const body = functionBody(
			source,
			"function validateAgentOutput(data: Record<string, unknown>): ValidationResult {",
		);
		assert.ok(maxBraceDepth(body) <= 2);
	});
});
