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
import { Type } from "typebox";
import { Value } from "typebox/value";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { buildRgArgs, buildGrepArgs } from "../backends.ts";
import { validateQuery } from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("validateQuery", () => {
	it("rejects 'class User' (collision rule)", () => {
		const result = validateQuery("class User");
		assert.ok(result !== null, "Expected error for class definition pattern");
		assert.ok(result!.includes("structural_search"), "Error should mention structural_search");
	});

	it("rejects 'def verify_token' (collision rule)", () => {
		const result = validateQuery("def verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects 'function bootstrap' (collision rule)", () => {
		const result = validateQuery("function bootstrap");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects pattern with $ (structural syntax)", () => {
		const result = validateQuery("console.log($A)");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects pattern with { (structural syntax)", () => {
		const result = validateQuery("try { $$$BODY }");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects empty string", () => {
		const result = validateQuery("");
		assert.ok(result !== null);
	});

	it("rejects whitespace-only string", () => {
		const result = validateQuery("   ");
		assert.ok(result !== null);
	});

	it("accepts plain literal 'TIMEOUT_MS = 5000'", () => {
		const result = validateQuery("TIMEOUT_MS = 5000");
		assert.strictEqual(result, null);
	});

	it("accepts single number '5000'", () => {
		const result = validateQuery("5000");
		assert.strictEqual(result, null);
	});

	it("accepts word 'error_log'", () => {
		const result = validateQuery("error_log");
		assert.strictEqual(result, null);
	});

	it("accepts regex 'TODO|FIXME'", () => {
		const result = validateQuery("TODO|FIXME");
		assert.strictEqual(result, null);
	});

	it("accepts dot-query 'user.id'", () => {
		const result = validateQuery("user.id");
		assert.strictEqual(result, null);
	});

	it("accepts natural text 'set timeout to 5000.'", () => {
		const result = validateQuery("set timeout to 5000.");
		assert.strictEqual(result, null);
	});

	it("accepts pattern with dots and parens 'verify_token()'", () => {
		const result = validateQuery("verify_token()");
		assert.strictEqual(result, null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// max_count schema type: Type.Number → Type.Integer (Issue 989)
// ═══════════════════════════════════════════════════════════════════════

describe("max_count schema — Type.Integer (Issue 989)", () => {
	const schema = Type.Object({
		max_count: Type.Optional(Type.Integer({ default: 10 })),
	});

	it("accepts integer 10", () => {
		assert.ok(Value.Check(schema, { max_count: 10 }));
	});

	it("accepts integer 0", () => {
		assert.ok(Value.Check(schema, { max_count: 0 }));
	});

	it("accepts integer 500", () => {
		assert.ok(Value.Check(schema, { max_count: 500 }));
	});

	it("rejects float 2.5", () => {
		assert.ok(!Value.Check(schema, { max_count: 2.5 }));
	});

	it("rejects float 3.14", () => {
		assert.ok(!Value.Check(schema, { max_count: 3.14 }));
	});

	it("rejects string '10'", () => {
		assert.ok(!Value.Check(schema, { max_count: "10" }));
	});

	it("rejects null", () => {
		assert.ok(!Value.Check(schema, { max_count: null }));
	});

	it("rejects boolean true", () => {
		assert.ok(!Value.Check(schema, { max_count: true }));
	});

	it("accepts empty object (optional with default 10)", () => {
		assert.ok(Value.Check(schema, {}), "Optional property should accept missing value");
	});
});

describe("buildRgArgs", () => {
	it("builds default args with max_count=10, directory='.'", () => {
		const { command, args } = buildRgArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "rg");
		assert.ok(args.includes("--vimgrep"));
		assert.ok(args.includes("--max-columns=200"));
		assert.ok(args.includes("--max-count=10"));
		assert.ok(args.includes("--no-heading"));
		assert.ok(args.includes("-j1"));
		assert.ok(args.includes("--hidden"), "Should include --hidden flag");
		assert.ok(args.includes("--glob"), "Should include --glob flag");
		assert.ok(args.includes("!.git/**"), "Should include .git exclusion glob");
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("uses custom max_count=5", () => {
		const { args } = buildRgArgs("query", ".", 5);
		assert.ok(args.includes("--max-count=5"));
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildRgArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query with backticks passed as separate array element (not shell-escaped)", () => {
		const { args } = buildRgArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("query with spaces is single array element", () => {
		const { args } = buildRgArgs("timeout = 5000", ".", 10);
		const queryIndex = args.indexOf("timeout = 5000");
		assert.ok(queryIndex >= 0, "Query with spaces should be a single array element");
	});

	it("all flags present in correct positions", () => {
		const { command, args } = buildRgArgs("test", ".", 10);
		assert.strictEqual(command, "rg");
		assert.strictEqual(args[0], "--vimgrep");
		assert.ok(args[1]!.startsWith("--max-columns="));
		assert.ok(args[2]!.startsWith("--max-count="));
		assert.strictEqual(args[3], "--no-heading");
		assert.strictEqual(args[4], "-j1");
		assert.strictEqual(args[5], "--hidden");
		assert.strictEqual(args[6], "--glob");
		assert.strictEqual(args[7], "!.git/**");
		assert.strictEqual(args[args.length - 1], ".", "directory is last");
		assert.strictEqual(args[args.length - 2], "test", "query precedes directory");
	});

	it("respects custom maxLineLength", () => {
		const { args } = buildRgArgs("query", ".", 10, 150);
		assert.ok(args.includes("--max-columns=150"));
	});

	it("defaults maxLineLength to 200", () => {
		const { args } = buildRgArgs("query", ".", 10);
		assert.ok(args.includes("--max-columns=200"));
	});
});

describe("buildGrepArgs", () => {
	it("builds default grep args with max_count=10, directory='.'", () => {
		const { command, args } = buildGrepArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "grep");
		assert.ok(args.includes("-rnH"));
		assert.ok(args.includes("-m"));
		assert.ok(args.includes("10"));
		assert.ok(args.includes("--color=never"));
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("includes all --exclude-dir flags", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		assert.ok(args.includes("--exclude-dir=.git"));
		assert.ok(args.includes("--exclude-dir=node_modules"));
		assert.ok(args.includes("--exclude-dir=venv"));
		assert.ok(args.includes("--exclude-dir=__pycache__"));
		assert.ok(args.includes("--exclude-dir=.mypy_cache"));
		assert.ok(args.includes("--exclude-dir=.pytest_cache"));
		assert.ok(args.includes("--exclude-dir=dist"));
		assert.ok(args.includes("--exclude-dir=build"));
	});

	it("excluded dirs appear before -e flag", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		const excludeIdx = args.indexOf("--exclude-dir=.git");
		const eIdx = args.indexOf("-e");
		assert.ok(excludeIdx >= 0, "--exclude-dir=.git should be present");
		assert.ok(eIdx >= 0, "-e should be present");
		assert.ok(excludeIdx < eIdx, "--exclude-dir flags should appear before -e");
	});

	it("uses custom max_count=5", () => {
		const { args } = buildGrepArgs("query", ".", 5);
		const mIdx = args.indexOf("-m");
		assert.ok(mIdx >= 0);
		assert.strictEqual(args[mIdx + 1], "5");
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildGrepArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query is separate array element (no shell injection)", () => {
		const { args } = buildGrepArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("all flags in expected order", () => {
		const { command, args } = buildGrepArgs("test", ".", 10);
		assert.strictEqual(command, "grep");
		assert.strictEqual(args[0], "-rnH");
		assert.strictEqual(args[1], "-m");
		assert.strictEqual(args[2], "10");
		assert.strictEqual(args[3], "--color=never");
		// Then exclusion dirs
		const excludeStart = args.indexOf("--exclude-dir=.git");
		assert.ok(excludeStart >= 4, "--exclude-dir should start after --color=never");
		// -e comes after all --exclude-dir entries, then query, then directory
		const eIdx = args.indexOf("-e");
		assert.ok(eIdx > excludeStart, "-e should come after all --exclude-dir entries");
		assert.strictEqual(args[eIdx + 1], "test", "query follows -e");
		assert.strictEqual(args[args.length - 1], ".", "directory is last");
	});
});
