/**
 * Phase 2: Type guard tests for lsp-auditor LSP types
 *
 * Tests isObject (via the type guards that use it), isLspDiagnosticData,
 * and isLspPublishDiagnosticsParams from lib/lsp-types.ts.
 * Pure functions only — no I/O, no Pi API.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor-types.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { isLspDiagnosticData, isLspPublishDiagnosticsParams } from "../lib/lsp-types.ts";

// ═══════════════════════════════════════════════════════════════════════
// isObject tests (tested through the type guards that use it)
// ═══════════════════════════════════════════════════════════════════════

describe("isLspDiagnosticData (exercises isObject)", () => {
	it("happy path: valid object with range and message returns true", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
			message: "test error",
		});
		assert.strictEqual(result, true);
	});

	it("null returns false", () => {
		assert.strictEqual(isLspDiagnosticData(null), false);
	});

	it("undefined returns false", () => {
		assert.strictEqual(isLspDiagnosticData(undefined), false);
	});

	it("array returns false (isObject rejects arrays)", () => {
		assert.strictEqual(isLspDiagnosticData([1, 2]), false);
	});

	it("string returns false", () => {
		assert.strictEqual(isLspDiagnosticData("string"), false);
	});

	it("number returns false", () => {
		assert.strictEqual(isLspDiagnosticData(42), false);
	});

	it("boolean returns false", () => {
		assert.strictEqual(isLspDiagnosticData(true), false);
	});

	it("missing message: object with range but no message returns false", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
		});
		assert.strictEqual(result, false);
	});

	it("missing range: object with message but no range returns false", () => {
		const result = isLspDiagnosticData({ message: "test" });
		assert.strictEqual(result, false);
	});

	it("range is not an object (non-null primitive) returns false", () => {
		const result = isLspDiagnosticData({
			range: "not-an-object",
			message: "test",
		});
		assert.strictEqual(result, false);
	});

	it("range is null returns false", () => {
		const result = isLspDiagnosticData({
			range: null,
			message: "test",
		});
		assert.strictEqual(result, false);
	});

	it("range is array returns false", () => {
		const result = isLspDiagnosticData({
			range: [],
			message: "test",
		});
		assert.strictEqual(result, false);
	});

	it("message is not a string returns false", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
			message: 42,
		});
		assert.strictEqual(result, false);
	});

	it("empty string message returns true (edge case)", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
			message: "",
		});
		assert.strictEqual(result, true);
	});

	it("valid with optional severity field returns true", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 10, character: 5 } },
			message: "warning",
			severity: 2,
			source: "ts",
		});
		assert.strictEqual(result, true);
	});

	it("empty object returns false (no range, no message)", () => {
		assert.strictEqual(isLspDiagnosticData({}), false);
	});
});

describe("isLspPublishDiagnosticsParams (exercises isObject)", () => {
	it("happy path: valid object with uri string and diagnostics array returns true", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
			diagnostics: [],
		});
		assert.strictEqual(result, true);
	});

	it("null returns false", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams(null), false);
	});

	it("undefined returns false", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams(undefined), false);
	});

	it("array returns false (isObject rejects arrays)", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams([1, 2]), false);
	});

	it("string returns false", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams("string"), false);
	});

	it("number returns false", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams(42), false);
	});

	it("boolean returns false", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams(true), false);
	});

	it("missing uri: object with diagnostics only returns false", () => {
		const result = isLspPublishDiagnosticsParams({
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
					message: "err",
				},
			],
		});
		assert.strictEqual(result, false);
	});

	it("missing diagnostics: object with uri only returns false", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
		});
		assert.strictEqual(result, false);
	});

	it("uri is not a string returns false", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: 42,
			diagnostics: [],
		});
		assert.strictEqual(result, false);
	});

	it("diagnostics is not an array returns false", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
			diagnostics: "not-an-array",
		});
		assert.strictEqual(result, false);
	});

	it("empty uri string returns true (edge case — type guard only checks typeof)", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "",
			diagnostics: [],
		});
		assert.strictEqual(result, true);
	});

	it("diagnostics array is null returns false", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
			diagnostics: null,
		});
		assert.strictEqual(result, false);
	});

	it("valid with actual diagnostics entries returns true", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
					message: "error 1",
				},
				{
					range: { start: { line: 2, character: 0 }, end: { line: 3, character: 1 } },
					message: "error 2",
				},
			],
		});
		assert.strictEqual(result, true);
	});

	it("empty object returns false (no uri, no diagnostics)", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams({}), false);
	});
});
