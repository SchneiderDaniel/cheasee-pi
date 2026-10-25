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

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { buildStructuredSummary, buildSearchErrorText } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("buildStructuredSummary", () => {
	it("0 matches — returns 'No matches found' message, no error", () => {
		const result: RgResult = { total_returned: 0, results: [] };
		const summary = buildStructuredSummary(result, "ripgrep", "TIMEOUT_MS", ".");
		assert.ok(summary.text.includes("No matches found"));
		assert.strictEqual(summary.details.total_returned, 0);
		assert.strictEqual(summary.details.success, true);
	});

	it("1000 matches — shows top-N (default 10) with truncated indicator and file count", () => {
		const results = [];
		for (let i = 0; i < 1000; i++) {
			results.push({
				file: i < 500 ? "src/a.ts" : "src/b.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 1000, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "TIMEOUT_MS", ".");

		// Shows searcher name
		assert.ok(summary.text.includes("ripgrep"));
		// Shows query
		assert.ok(summary.text.includes("TIMEOUT_MS"));
		// Shows directory
		assert.ok(summary.text.includes("Directory: ."));
		// Shows total
		assert.ok(summary.text.includes("1000"));
		// Shows unique file count
		assert.ok(summary.text.includes("across 2 files"));
		// Shows truncated indicator
		assert.ok(summary.text.includes("Showing first 10 of 1000"));
		// Shows only 10 result lines
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 10);
	});

	it("≤10 matches — all shown, no truncated indicator", () => {
		const results = [
			{ file: "a.ts", line: 1, column: 1, text: "one" },
			{ file: "b.ts", line: 2, column: 1, text: "two" },
		];
		const result: RgResult = { total_returned: 2, results };
		const summary = buildStructuredSummary(result, "grep", "query", ".");
		assert.ok(summary.text.includes("Matches returned: 2"));
		assert.ok(summary.text.includes("1. a.ts:1:1:one"));
		assert.ok(summary.text.includes("2. b.ts:2:1:two"));
		assert.ok(!summary.text.includes("Showing first"));
	});

	it("summary includes searcher name, query string, directory", () => {
		const result: RgResult = {
			total_returned: 1,
			results: [{ file: "a.ts", line: 1, column: 1, text: "x" }],
		};
		const summary = buildStructuredSummary(result, "ripgrep", "foo", "src/");
		assert.ok(summary.text.includes("ripgrep"));
		assert.ok(summary.text.includes("foo"));
		assert.ok(summary.text.includes("Directory: src/"));
	});

	it("single match — rendered correctly with count = 1", () => {
		const result: RgResult = {
			total_returned: 1,
			results: [{ file: "a.ts", line: 1, column: 1, text: "x" }],
		};
		const summary = buildStructuredSummary(result, "ripgrep", "x", ".");
		assert.ok(summary.text.includes("Matches returned: 1"));
		assert.ok(summary.text.includes("1 file"));
		assert.ok(summary.text.includes("1. a.ts:1:1:x"));
	});

	it("matches across 1 file vs 100 files — unique file count correct", () => {
		// 1 file
		const results1 = [
			{ file: "a.ts", line: 1, column: 1, text: "x" },
			{ file: "a.ts", line: 2, column: 1, text: "y" },
		];
		const r1: RgResult = { total_returned: 2, results: results1 };
		const summary1 = buildStructuredSummary(r1, "ripgrep", "q", ".");
		assert.ok(summary1.text.includes("1 file"));

		// 100 files (need 10 unique files to display in top-N)
		const results2 = [];
		for (let i = 0; i < 10; i++) {
			results2.push({
				file: `file${i}.ts`,
				line: 1,
				column: 1,
				text: "x",
			});
		}
		// Add 90 more results across same files to make total 100
		for (let i = 0; i < 90; i++) {
			results2.push({
				file: `file${i % 10}.ts`,
				line: i + 2,
				column: 1,
				text: "x",
			});
		}
		const r2: RgResult = { total_returned: 100, results: results2, truncated: true };
		const summary2 = buildStructuredSummary(r2, "ripgrep", "q", ".");
		assert.ok(summary2.text.includes("across 10 files"));
	});

	it("max_count override (top-5) respected", () => {
		const results = [];
		for (let i = 0; i < 20; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 20, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".", 5);
		assert.ok(summary.text.includes("Showing first 5 of 20"));
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 5);
	});

	it("max_count override (top-20) respected", () => {
		const results = [];
		for (let i = 0; i < 30; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 30, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".", 20);
		assert.ok(summary.text.includes("Showing first 20 of 30"));
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 20);
	});

	it("null/undefined raw stdout — empty summary, no crash", () => {
		// buildStructuredSummary doesn't take rawStdout — test that
		// an empty result set with no content doesn't crash
		const result: RgResult = { total_returned: 0, results: [] };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		assert.ok(summary.text.includes("No matches found"));
		assert.strictEqual(summary.details.total_returned, 0);
	});

	it("top-N results show correct file:line:column:text format", () => {
		const results = [
			{ file: "src/app.ts", line: 42, column: 16, text: "const x = 1;" },
			{ file: "config/settings.py", line: 4, column: 8, text: "TIMEOUT_MS = 5000" },
		];
		const result: RgResult = { total_returned: 2, results };
		const summary = buildStructuredSummary(result, "ripgrep", "5000", ".");
		assert.ok(summary.text.includes("1. src/app.ts:42:16:const x = 1;"));
		assert.ok(summary.text.includes("2. config/settings.py:4:8:TIMEOUT_MS = 5000"));
	});

	it("truncated indicator formatted correctly — bracket closed inline", () => {
		const results = [];
		for (let i = 0; i < 15; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 15, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		// Bracket closed inline by buildStructuredSummary
		assert.ok(summary.text.includes("[Showing first 10 of 15 results across 1 file.]"));
		assert.strictEqual(summary.details.truncated, true);
	});

	it("15 results, not truncated by parser — bracket closed (11-499 gap)", () => {
		const results = [];
		for (let i = 0; i < 15; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 15, results, truncated: false };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		// Bracket closed inline even when parser did not truncate
		assert.ok(summary.text.includes("[Showing first 10 of 15 results across 1 file.]"));
		assert.strictEqual(summary.details.truncated, true);
		// No extra trailing bracket
		const bracketCount = (summary.text.match(/\]/g) || []).length;
		assert.strictEqual(bracketCount, 1, "Should have exactly one closing bracket");
	});

	it("exactly 11 results, not truncated by parser — bracket closed (boundary)", () => {
		const results = [];
		for (let i = 0; i < 11; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 11, results, truncated: false };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		assert.ok(summary.text.includes("[Showing first 10 of 11 results across 1 file.]"));
		assert.strictEqual(summary.details.truncated, true);
	});

	it("exactly 499 results, not truncated by parser — bracket closed (just below MAX_TOTAL_RESULTS)", () => {
		const results = [];
		for (let i = 0; i < 499; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 499, results, truncated: false };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		assert.ok(summary.text.includes("[Showing first 10 of 499 results across 1 file.]"));
		assert.strictEqual(summary.details.truncated, true);
	});

	// ── Phase 1: Truncation behavior in buildStructuredSummary ──

	describe("line truncation via truncateLine", () => {
		it("line > 500 chars → truncated text ends with '... [truncated]' suffix", () => {
			const longText = "x".repeat(600);
			const results = [{ file: "a.ts", line: 1, column: 1, text: longText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			assert.ok(summary.text.includes("... [truncated]"), "Should have truncation suffix");
			// Total line in output should be 500 + suffix length
			const lineMatch = summary.text.match(/1\. a\.ts:1:1:(.+)/);
			assert.ok(lineMatch, "Should match result line format");
			const displayedText = lineMatch![1]!;
			assert.ok(displayedText.endsWith("... [truncated]"));
			assert.strictEqual(displayedText.length, 500 + "... [truncated]".length);
		});

		it("line ≤ 500 chars → text passed through unchanged", () => {
			const shortText = "Hello world";
			const results = [{ file: "a.ts", line: 1, column: 1, text: shortText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			assert.ok(summary.text.includes("Hello world"), "Short text should pass through unchanged");
			assert.ok(
				!summary.text.includes("... [truncated]"),
				"Short text should not have truncation suffix",
			);
		});

		it("line exactly 500 chars → no truncation", () => {
			const exactText = "x".repeat(500);
			const results = [{ file: "a.ts", line: 1, column: 1, text: exactText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			// Should NOT contain truncation suffix — exactly at boundary
			assert.ok(
				!summary.text.includes("... [truncated]"),
				"Exact 500-char line should not be truncated",
			);
			// All 500 chars should be present
			assert.ok(summary.text.includes(exactText), "All 500 chars should be visible");
		});

		it("line at 501 chars → truncation applied, suffix present and length correct", () => {
			const text501 = "x".repeat(501);
			const results = [{ file: "a.ts", line: 1, column: 1, text: text501 }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			const lineMatch = summary.text.match(/1\. a\.ts:1:1:(.+)/);
			assert.ok(lineMatch, "Should match result line format");
			const displayedText = lineMatch![1]!;
			assert.ok(
				displayedText.endsWith("... [truncated]"),
				"501-char line should be truncated with suffix",
			);
			// 500 chars + suffix
			assert.strictEqual(
				displayedText.length,
				500 + "... [truncated]".length,
				"Truncated line should be exactly 500 chars + suffix",
			);
		});
	});
});

// buildSearchErrorText
// ═══════════════════════════════════════════════════════════════════════

describe("buildSearchErrorText", () => {
	it("buildSearchErrorText is exported function", () => {
		assert.strictEqual(typeof buildSearchErrorText, "function");
	});

	it("killed process produces 'killed' in message", () => {
		const result = buildSearchErrorText("ripgrep", 9, true, "", "ripgrep (\`rg --version\`)", ".");
		assert.ok(result.includes("killed"), "Should mention killed");
	});

	it("empty stderr produces 'no error output' in message", () => {
		const result = buildSearchErrorText("grep", 2, false, "", "grep", ".");
		assert.ok(result.includes("no error output"), "Should mention no error output");
	});

	it("stderr matching 'command not found' produces install hint", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			127,
			false,
			"bash: rg: command not found",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("Ensure"));
	});

	it("stderr matching 'No such file or directory' produces not-found hint", () => {
		const result = buildSearchErrorText(
			"grep",
			2,
			false,
			"grep: foo: No such file or directory",
			"grep",
			"foo",
		);
		assert.ok(
			result.includes("not found or inaccessible"),
			"Should mention directory not accessible",
		);
	});

	it("fallback generic error includes stderr text and exit code", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			13,
			false,
			"something went wrong",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("something went wrong"), "Should include stderr");
		assert.ok(result.includes("exit 13"), "Should include exit code");
	});

	it("exit code 1 (no matches) does not call buildSearchErrorText in execute — characterization", () => {
		const result = buildSearchErrorText("ripgrep", 1, false, "", "ripgrep (\`rg --version\`)", ".");
		assert.ok(result.includes("no error output"), "Code 1 with empty stderr -> no error output");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Backend auto-detection (config.ts already tested above)
// The resolveBackend tests in the config section already cover:
//   - ripgrepAvailable returns true → backend ripgrep
//   - ripgrepAvailable returns false → backend grep
//   - Config override "grep" → skip rg check
// ═══════════════════════════════════════════════════════════════════════
