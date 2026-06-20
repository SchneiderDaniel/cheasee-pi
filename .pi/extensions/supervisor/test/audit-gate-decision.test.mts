/**
 * Tests for audit-gate-decision — unified audit-gate decision module.
 *
 * Phase 1: Shared frame (passthrough, null-result routing)
 * Phase 2: tsc policy (error routing, clean routing)
 * Phase 3: lsp policy (skip conditions, retry thresholds, edge cases)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-gate-decision.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { determineAuditGate } from "../checks/audit-gate-decision.ts";
import type { AuditGateDecision } from "../checks/audit-gate-decision.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Shared frame — passthrough and null-result routing
// ═══════════════════════════════════════════════════════════════════════

describe("determineAuditGate — shared frame", () => {
	it('intendedNext !== "Audit" with tsc policy → passthrough', () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Implementation",
			result: { diagnostics: [], hasErrors: true },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, false);
		assert.strictEqual(result.note, "");
	});

	it('intendedNext !== "Audit" with lsp policy → passthrough', () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Blocked",
			result: { proceed: true, note: "should not appear" },
		});
		assert.strictEqual(result.nextStatus, "Blocked");
		assert.strictEqual(result.triggered, false);
		assert.strictEqual(result.note, "");
	});

	it('intendedNext === "Audit", null result, tsc policy → Audit with skip note', () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: null,
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("skipped"));
		assert.strictEqual(result.triggered, false);
	});

	it('intendedNext === "Audit", null result, lsp policy → Audit with empty note', () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: null,
			context: { hasModifiedFiles: true, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.note, "");
		assert.strictEqual(result.triggered, false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: tsc policy — error routing and clean routing
// ═══════════════════════════════════════════════════════════════════════

describe("determineAuditGate — tsc policy", () => {
	it("hasErrors → stay in Implementation", () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: {
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
						filePath: "/abs/a.ts",
					},
				],
				hasErrors: true,
			},
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("hasErrors → note includes diagnostics", () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: {
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
						filePath: "/abs/a.ts",
					},
				],
				hasErrors: true,
			},
		});
		assert.ok(result.note.includes("Type error"));
		assert.ok(result.note.includes("TS2322"));
	});

	it("clean (no errors) → proceed to Audit", () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: { diagnostics: [], hasErrors: false },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("no type errors"));
		assert.strictEqual(result.triggered, true);
	});

	it("empty diagnostics, hasErrors false → clean proceed", () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: { diagnostics: [], hasErrors: false },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.triggered, true);
	});

	it("null result → Audit with skip note (triggered false)", () => {
		const result = determineAuditGate({
			policyName: "tsc",
			intendedNext: "Audit",
			result: null,
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("skipped"));
		assert.strictEqual(result.triggered, false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: lsp policy — skip conditions, retry thresholds, edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("determineAuditGate — lsp policy", () => {
	it("!hasModifiedFiles → Audit with skip note", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "would block" },
			context: { hasModifiedFiles: false, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("no modified files") || result.note.includes("skipped"));
		assert.strictEqual(result.triggered, false);
	});

	it("hasModifiedFiles, proceed true → Audit", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: true, note: "all clean" },
			context: { hasModifiedFiles: true, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.note, "all clean");
		assert.strictEqual(result.triggered, true);
	});

	it("hasModifiedFiles, !proceed, retry 0 → Implementation", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("hasModifiedFiles, !proceed, retry 2 → Implementation", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: 2 },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("hasModifiedFiles, !proceed, retry 3 → Audit (retries exhausted)", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: 3 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.triggered, true);
	});

	it("hasModifiedFiles, !proceed, retry 5 → Audit (retries exhausted)", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: 5 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.triggered, true);
	});

	it("proceed true wins over low retry count → Audit", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: true, note: "all clean" },
			context: { hasModifiedFiles: true, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.triggered, true);
	});

	it("null result → Audit with empty note", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: null,
			context: { hasModifiedFiles: true, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.triggered, false);
	});

	it("retry NaN → normalized to 0 → Implementation", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: NaN },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("retry -1 → normalized to 0 → Implementation", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true, retryCount: -1 },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("retry undefined → normalized to 0 → Implementation", () => {
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: { proceed: false, note: "errors found" },
			context: { hasModifiedFiles: true },
		});
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.triggered, true);
	});

	it("!hasModifiedFiles with null result → skip takes priority", () => {
		// !hasModifiedFiles check comes before null result check
		const result = determineAuditGate({
			policyName: "lsp",
			intendedNext: "Audit",
			result: null,
			context: { hasModifiedFiles: false, retryCount: 0 },
		});
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("no modified files") || result.note.includes("skipped"));
		assert.strictEqual(result.triggered, false);
	});
});
