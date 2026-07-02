/**
 * Public API tests for lsp-types.ts
 *
 * Verifies surviving exports are present, correct, and deleted interfaces
 * are not re-exported at runtime.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-types-public-api.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { isLspDiagnosticData, isLspPublishDiagnosticsParams } from "../lib/lsp-types.ts";

// ─── Exported function assertions ────────────────────────────────────

describe("lsp-types public API (surviving exports)", () => {
	it("isLspDiagnosticData is a function", () => {
		assert.strictEqual(typeof isLspDiagnosticData, "function");
	});

	it("isLspPublishDiagnosticsParams is a function", () => {
		assert.strictEqual(typeof isLspPublishDiagnosticsParams, "function");
	});

	it("isLspDiagnosticData returns true for valid input", () => {
		const result = isLspDiagnosticData({
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
			message: "test",
		});
		assert.strictEqual(result, true);
	});

	it("isLspDiagnosticData returns false for null", () => {
		assert.strictEqual(isLspDiagnosticData(null), false);
	});

	it("isLspPublishDiagnosticsParams returns true for valid input", () => {
		const result = isLspPublishDiagnosticsParams({
			uri: "file:///test.ts",
			diagnostics: [],
		});
		assert.strictEqual(result, true);
	});

	it("isLspPublishDiagnosticsParams returns false for null", () => {
		assert.strictEqual(isLspPublishDiagnosticsParams(null), false);
	});

	it("runtime export names do not include deleted interfaces", async () => {
		const mod = await import("../lib/lsp-types.ts");
		const exportNames = Object.keys(mod);
		for (const name of ["LspTextDocumentItem", "LspInitializeParams", "LspInitializeResult"]) {
			assert.ok(
				!exportNames.includes(name),
				`deleted export "${name}" must not appear in module exports`,
			);
		}
	});
});
