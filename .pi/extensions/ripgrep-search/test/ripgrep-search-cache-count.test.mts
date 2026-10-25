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
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import {
	getCachedResult,
	setCachedResult,
	clearCache,
	resultCache,
	buildCacheKey,
} from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("cache module", () => {
	beforeEach(() => {
		clearCache();
	});

	// ── Unit: get/set/clear ──

	describe("getCachedResult / setCachedResult", () => {
		it("stores and retrieves a result by query+directory+maxCount", () => {
			const entry = {
				result: { total_returned: 2, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			};
			setCachedResult("foo", ".", 10, entry);
			const cached = getCachedResult("foo", ".", 10);
			assert.ok(cached !== undefined);
			assert.strictEqual(cached!.result.total_returned, 2);
			assert.strictEqual(cached!.rawStdout, "a.ts:1:1:x");
		});

		it("different query — cache miss", () => {
			setCachedResult("foo", ".", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			const cached = getCachedResult("bar", ".", 10);
			assert.strictEqual(cached, undefined);
		});

		it("same query, different directory — cache miss", () => {
			setCachedResult("foo", "src", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			const cached = getCachedResult("foo", "lib", 10);
			assert.strictEqual(cached, undefined);
		});
	});

	// ── Per-width get/set isolation (Issue 1731) ──

	describe("per-width get/set isolation (Issue 1731)", () => {
		it("stored at width 10 is not served for width 500 (the reported bug)", () => {
			const entryA = {
				result: { total_returned: 3, results: [] },
				rawStdout: "3 matches",
			};
			setCachedResult("q", ".", 10, entryA);
			assert.strictEqual(getCachedResult("q", ".", 500), undefined);
			assert.strictEqual(getCachedResult("q", ".", 10), entryA);
		});

		it("widths 10 and 500 hold distinct entries", () => {
			const entryA = { result: { total_returned: 3, results: [] }, rawStdout: "narrow" };
			const entryB = { result: { total_returned: 42, results: [] }, rawStdout: "wide" };
			setCachedResult("q", ".", 10, entryA);
			setCachedResult("q", ".", 500, entryB);
			assert.strictEqual(getCachedResult("q", ".", 10)!.result.total_returned, 3);
			assert.strictEqual(getCachedResult("q", ".", 500)!.result.total_returned, 42);
		});

		it("wider store does not overwrite narrower entry", () => {
			const entryA = { result: { total_returned: 3, results: [] }, rawStdout: "narrow" };
			const entryB = { result: { total_returned: 42, results: [] }, rawStdout: "wide" };
			setCachedResult("q", ".", 10, entryA);
			setCachedResult("q", ".", 500, entryB);
			assert.strictEqual(getCachedResult("q", ".", 10), entryA);
		});

		it("normalized directory + width: hit on same width, miss on wider", () => {
			const entryA = { result: { total_returned: 1, results: [] }, rawStdout: "" };
			setCachedResult("q", "src", 10, entryA);
			assert.strictEqual(getCachedResult("q", "./src", 10), entryA);
			assert.strictEqual(getCachedResult("q", "./src", 500), undefined);
		});

		it("same width, different directory — cache miss (existing dimension preserved)", () => {
			setCachedResult("q", "src", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			assert.strictEqual(getCachedResult("q", "lib", 10), undefined);
		});
	});

	// ── buildCacheKey (format + collision resistance) ──

	describe("buildCacheKey", () => {
		it("returns valid JSON containing query, directory, and maxCount", () => {
			const key = buildCacheKey("foo", "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "foo");
			assert.strictEqual(parsed.directory, "src");
			assert.strictEqual(parsed.maxCount, 10);
		});

		it("different inputs with :: produce different keys (collision guard)", () => {
			const key1 = buildCacheKey("a::b", "src", 10);
			const key2 = buildCacheKey("a", "b::src", 10);
			assert.notStrictEqual(key1, key2);
		});

		it("same inputs produce identical keys (determinism)", () => {
			const key1 = buildCacheKey("a::b", "src", 10);
			const key2 = buildCacheKey("a::b", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it('normalizes "./src" and "src" to same key', () => {
			const key1 = buildCacheKey("foo", "./src", 10);
			const key2 = buildCacheKey("foo", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it("handles query with double quotes", () => {
			const key = buildCacheKey('hello"world', "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, 'hello"world');
		});

		it("handles query with backslash", () => {
			const key = buildCacheKey("a\\b", "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "a\\b");
		});

		it("handles query with null byte", () => {
			const key = buildCacheKey("a\x00b", "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "a\x00b");
		});

		it("handles query with emoji", () => {
			const key = buildCacheKey("🔥", "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "🔥");
		});

		it("handles empty query string", () => {
			const key = buildCacheKey("", "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "");
			assert.strictEqual(parsed.directory, "src");
		});

		it("handles very long query string", () => {
			const longQuery = "x".repeat(10000);
			const key = buildCacheKey(longQuery, "src", 10);
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, longQuery);
			assert.strictEqual(parsed.directory, "src");
		});

		it("normalizes './src/' and 'src' to same key (combined normalization)", () => {
			const key1 = buildCacheKey("foo", "./src/", 10);
			const key2 = buildCacheKey("foo", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it('empty directory normalized to "."', () => {
			const key1 = buildCacheKey("foo", "", 10);
			const key2 = buildCacheKey("foo", ".", 10);
			assert.strictEqual(key1, key2);
		});

		it("cache hit still works via new key format", () => {
			setCachedResult("a::b", "src", 10, {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			const cached = getCachedResult("a::b", "src", 10);
			assert.ok(cached !== undefined, "Should find cached entry");
			assert.strictEqual(cached!.result.total_returned, 1);
		});

		it("no false cache hit when :: in query collides with :: in directory", () => {
			setCachedResult("a::b", "src", 10, {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			// This should be a different key, so getCachedResult must return undefined
			const cached = getCachedResult("a", "b::src", 10);
			assert.strictEqual(cached, undefined);
		});
	});

	// ── Cache key completeness over max_count (Issue 1731, core regression) ──

	describe("buildCacheKey — maxCount completeness (Issue 1731)", () => {
		it("keys differ across widths: (q, d, 10) !== (q, d, 500)", () => {
			assert.notStrictEqual(buildCacheKey("TODO", ".", 10), buildCacheKey("TODO", ".", 500));
		});

		it("serialized key carries numeric maxCount", () => {
			const parsed = JSON.parse(buildCacheKey("q", "src", 10));
			assert.strictEqual(parsed.maxCount, 10);
		});

		it("width is independent of directory normalization", () => {
			assert.notStrictEqual(buildCacheKey("q", "src", 10), buildCacheKey("q", "./src", 500));
		});

		it("boundary widths 0, 1, 10, 500 are pairwise distinct", () => {
			const keys = [0, 1, 10, 500].map((n) => buildCacheKey("q", "src", n));
			assert.strictEqual(new Set(keys).size, keys.length);
		});

		it("special-char query round-trips with width", () => {
			const parsed = JSON.parse(buildCacheKey('hello"world', "src", 10));
			assert.strictEqual(parsed.query, 'hello"world');
			assert.strictEqual(parsed.maxCount, 10);
		});
	});

	// ── Path normalization ──

	describe("path normalization", () => {
		it('"./src" and "src" produce same cache key', () => {
			const key1 = buildCacheKey("foo", "./src", 10);
			const key2 = buildCacheKey("foo", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it('"src/" and "src" produce same cache key', () => {
			const key1 = buildCacheKey("foo", "src/", 10);
			const key2 = buildCacheKey("foo", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it('"." and "" produce same cache key (empty normalized to ".")', () => {
			const key1 = buildCacheKey("foo", ".", 10);
			const key2 = buildCacheKey("foo", "./", 10);
			assert.strictEqual(key1, key2);
		});

		it('"./src/" and "src" — same key (trailing slash + dot-prefix)', () => {
			const key1 = buildCacheKey("foo", "./src/", 10);
			const key2 = buildCacheKey("foo", "src", 10);
			assert.strictEqual(key1, key2);
		});

		it('normalized path: "./src" → cache hit when previously stored as "src"', () => {
			setCachedResult("foo", "src", 10, {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			const cached = getCachedResult("foo", "./src", 10);
			assert.ok(cached !== undefined, "Should find cached entry via normalized path");
		});
	});

	// ── clearCache ──

	describe("clearCache", () => {
		it("clears all cached entries", () => {
			setCachedResult("a", ".", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			setCachedResult("b", ".", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			assert.strictEqual(resultCache.size, 2);
			clearCache();
			assert.strictEqual(resultCache.size, 0);
		});

		it("after clear, get returns undefined", () => {
			setCachedResult("foo", ".", 10, {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			clearCache();
			const cached = getCachedResult("foo", ".", 10);
			assert.strictEqual(cached, undefined);
		});

		it("removes width-keyed entries", () => {
			setCachedResult("q", ".", 10, { result: { total_returned: 1, results: [] }, rawStdout: "" });
			setCachedResult("q", ".", 500, { result: { total_returned: 1, results: [] }, rawStdout: "" });
			assert.strictEqual(resultCache.size, 2);
			clearCache();
			assert.strictEqual(getCachedResult("q", ".", 10), undefined);
			assert.strictEqual(getCachedResult("q", ".", 500), undefined);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// execute wires resolved maxCount into both cache call sites (Issue 1731)
// ═══════════════════════════════════════════════════════════════════════

describe("execute — resolved maxCount keyed into cache (Issue 1731)", () => {
	let tmpCwd: string;
	let tool: any;
	let searchExecCount: number;
	let lastSearchArgs: string[];
	let failCode: number | null;

	function makeMockPi() {
		const handlers = new Map<string, Function>();
		let captured: any;
		const exec = async (command: string, args: string[]) => {
			if (command === "rg") return { code: 1, stdout: "", stderr: "" };
			searchExecCount++;
			lastSearchArgs = args;
			if (failCode !== null) return { code: failCode, stdout: "", stderr: "boom" };
			const mIdx = args.indexOf("-m");
			const width = mIdx >= 0 ? parseInt(args[mIdx + 1]!, 10) : 0;
			const n = Math.min(Number.isFinite(width) ? width : 0, 500);
			const stdout = Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}:match ${i + 1}`).join(
				"\n",
			);
			return { code: n > 0 ? 0 : 1, stdout, stderr: "" };
		};
		const pi = {
			on: (e: string, h: Function) => handlers.set(e, h),
			registerTool: (t: any) => {
				captured = t;
			},
			exec,
		};
		return { pi, getTool: () => captured };
	}

	async function call(maxCount: number | undefined): Promise<any> {
		const params: Record<string, unknown> = { query: "TODO", directory: "src" };
		if (maxCount !== undefined) params.max_count = maxCount;
		return tool.execute("tc", params, undefined, undefined, { cwd: tmpCwd });
	}

	beforeEach(async () => {
		clearCache();
		searchExecCount = 0;
		lastSearchArgs = [];
		failCode = null;
		tmpCwd = mkdtempSync(join(tmpdir(), "pi-rg-cache-"));
		mkdirSync(join(tmpCwd, ".pi"));
		writeFileSync(
			join(tmpCwd, ".pi", "settings.json"),
			JSON.stringify({ search: { searchBackend: "grep" } }),
		);
		mkdirSync(join(tmpCwd, "src"));
		const { pi, getTool } = makeMockPi();
		const { default: ripgrepSearch } = await import("../index.ts");
		ripgrepSearch(pi as any);
		tool = getTool();
	});

	afterEach(() => {
		clearCache();
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("wider max_count re-runs the CLI and returns the wider total", async () => {
		const r1 = await call(10);
		assert.strictEqual(r1.details.total_returned, 10);
		const r2 = await call(500);
		assert.strictEqual(searchExecCount, 2, "wider request must not reuse the narrow cache entry");
		assert.strictEqual(r2.details.total_returned, 500);
	});

	it("second call's exec args carry the wider per-file cap", async () => {
		await call(10);
		await call(500);
		const mIdx = lastSearchArgs.indexOf("-m");
		assert.ok(mIdx >= 0, "grep args should contain -m");
		assert.strictEqual(lastSearchArgs[mIdx + 1], "500");
	});

	it("omitted max_count then explicit 10 collapse to one cache key", async () => {
		await call(undefined);
		await call(10);
		assert.strictEqual(searchExecCount, 1, "resolved default should hit the cached entry");
	});

	it("same query + same max_count twice is a cache hit", async () => {
		const r1 = await call(10);
		const r2 = await call(10);
		assert.strictEqual(searchExecCount, 1);
		assert.strictEqual(r1.details.total_returned, r2.details.total_returned);
	});

	it("cache hit at matching width returns correct summary total", async () => {
		await call(10);
		const r2 = await call(10);
		assert.strictEqual(searchExecCount, 1);
		assert.strictEqual(r2.details.total_returned, 10);
	});

	it("failed exec resolves with isError and does not poison the cache", async () => {
		failCode = 2;
		const r = await call(10);
		assert.strictEqual(r.isError, true);
		assert.ok(/grep failed/.test(r.content[0].text));
		assert.strictEqual(resultCache.size, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Structured summarizer (buildStructuredSummary from index.ts)
// ═══════════════════════════════════════════════════════════════════════
