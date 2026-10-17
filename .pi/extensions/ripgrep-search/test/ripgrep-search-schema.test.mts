/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests import from .pi/extensions/ripgrep-search/ modules
 * instead of maintaining inline copies (avoids divergence risk).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against .pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Value } from "typebox/value";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { RipgrepSearchOutputSchema } from "../types.ts";
import { buildStructuredContent, buildErrorStructuredContent } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("RipgrepSearchOutputSchema + structured builders (Issue 1791)", () => {
	it("multi-result shape matches the schema and maps RgMatch verbatim", () => {
		const out = buildStructuredContent(
			{
				total_returned: 2,
				results: [
					{ file: "a.ts", line: 1, column: 3, text: "x" },
					{ file: "b.ts", line: 2, column: 1, text: "y" },
				],
			},
			"ripgrep",
			"TODO",
			"src",
		);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.strictEqual(out.total_returned, 2);
		assert.strictEqual(out.truncated, false);
		assert.deepStrictEqual(out.results[0], { file: "a.ts", line: 1, column: 3, text: "x" });
	});

	it("single-result shape matches the schema", () => {
		const out = buildStructuredContent(
			{ total_returned: 1, results: [{ file: "a.ts", line: 9, column: 2, text: "z" }] },
			"grep",
			"NEEDLE",
			".",
		);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.strictEqual(out.total_returned, 1);
	});

	it("zero-result shape matches the schema", () => {
		const out = buildStructuredContent({ total_returned: 0, results: [] }, "grep", "NONE", ".");
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.strictEqual(out.total_returned, 0);
		assert.deepStrictEqual(out.results, []);
		assert.strictEqual(out.truncated, false);
	});

	it("truncated:true carries through from RgResult", () => {
		const out = buildStructuredContent(
			{ total_returned: 500, results: [], truncated: true },
			"ripgrep",
			"TODO",
			".",
		);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.strictEqual(out.truncated, true);
	});

	it("echoes request-scoped query/directory/searcher over a cache-shaped RgResult", () => {
		// RgResult carries no query/directory/searcher — the boundary rebuilds them.
		const out = buildStructuredContent({ total_returned: 0, results: [] }, "grep", "NEEDLE", "lib");
		assert.strictEqual(out.query, "NEEDLE");
		assert.strictEqual(out.directory, "lib");
		assert.strictEqual(out.searcher, "grep");
	});

	it("error builder matches the schema with zeroed result fields", () => {
		const out = buildErrorStructuredContent("grep", "TODO", "src", "boom", 2);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.strictEqual(out.error, "boom");
		assert.strictEqual(out.code, 2);
		assert.strictEqual(out.total_returned, 0);
		assert.deepStrictEqual(out.results, []);
		assert.strictEqual(out.truncated, false);
		assert.strictEqual(out.query, "TODO");
		assert.strictEqual(out.searcher, "grep");
		assert.strictEqual(out.directory, "src");
	});

	it("error builder omits code when the exit code is unknown (null)", () => {
		const out = buildErrorStructuredContent("grep", "TODO", "src", "boom", null);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, out));
		assert.ok(!("code" in out), "code must be absent, not null");
	});

	it("required fields are required; error/code are optional", () => {
		const base = buildStructuredContent({ total_returned: 0, results: [] }, "grep", "q", ".");
		assert.ok(Value.Check(RipgrepSearchOutputSchema, base), "absent error/code must validate");

		const { query: _q, ...withoutQuery } = base;
		assert.ok(!Value.Check(RipgrepSearchOutputSchema, withoutQuery), "query must be required");

		const { total_returned: _t, ...withoutTotal } = base;
		assert.ok(
			!Value.Check(RipgrepSearchOutputSchema, withoutTotal),
			"total_returned must be required",
		);
	});

	it("schema properties carry no description (keeps codemode declaration compact)", () => {
		const props = (RipgrepSearchOutputSchema as any).properties as Record<string, unknown>;
		for (const key of Object.keys(props)) {
			assert.strictEqual(
				(props[key] as { description?: string }).description,
				undefined,
				`${key} must not carry a description`,
			);
		}
	});
});
