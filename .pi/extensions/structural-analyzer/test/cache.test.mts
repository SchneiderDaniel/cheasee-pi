/**
 * Tests: cache.ts — FIFO bounded cache
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { clearResultCache, makeCacheKey, setCache, getCache, MAX_CACHE_SIZE } from "../cache.ts";
import type { ExecResultResponse } from "../types.ts";

function makeResponse(overrides?: Partial<ExecResultResponse>): ExecResultResponse {
	return {
		content: [{ type: "text", text: "result" }],
		details: { success: true, matches: 0, results: [] },
		...overrides,
	};
}

describe("makeCacheKey", () => {
	it("returns deterministic key with \\x00 separator", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		assert.strictEqual(key, "pat\x00ts\x00/p");
	});

	it("same inputs produce identical key", () => {
		const a = makeCacheKey("pat", "ts", "/p");
		const b = makeCacheKey("pat", "ts", "/p");
		assert.strictEqual(a, b);
	});

	it("different patterns produce distinct keys", () => {
		const a = makeCacheKey("pat1", "ts", "/p");
		const b = makeCacheKey("pat2", "ts", "/p");
		assert.notStrictEqual(a, b);
	});

	it("different languages produce distinct keys", () => {
		const a = makeCacheKey("pat", "ts", "/p");
		const b = makeCacheKey("pat", "py", "/p");
		assert.notStrictEqual(a, b);
	});

	it("different cwds produce distinct keys", () => {
		const a = makeCacheKey("pat", "ts", "/p1");
		const b = makeCacheKey("pat", "ts", "/p2");
		assert.notStrictEqual(a, b);
	});

	it("\\x00 separator prevents collision: pattern 'a::b' + language 'ts' vs pattern 'a' + language 'b::ts'", () => {
		const a = makeCacheKey("a::b", "ts", "/p");
		const b = makeCacheKey("a", "b::ts", "/p");
		assert.notStrictEqual(a, b);
	});

	it("\\x00 separator prevents collision: pattern 'a::b' + cwd '/p' vs pattern 'a' + cwd 'b::/p'", () => {
		const a = makeCacheKey("a::b", "ts", "/p");
		const b = makeCacheKey("a", "ts", "b::/p");
		assert.notStrictEqual(a, b);
	});

	it("handles special chars: try/catch pattern", () => {
		const key = makeCacheKey("try { $$$BODY } catch (e) { $A }", "ts", "/p");
		assert.ok(key.includes("try"));
		assert.ok(key.includes("$$$BODY"));
		assert.ok(key.includes("\x00"));
	});
});

describe("cache set/get/clear", () => {
	beforeEach(() => {
		clearResultCache();
	});

	it("set and get a value", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const value = makeResponse();
		setCache(key, value);
		const got = getCache(key);
		assert.strictEqual(got, value);
	});

	it("get returns undefined for missing key", () => {
		const got = getCache("nonexistent");
		assert.strictEqual(got, undefined);
	});

	it("clear empties cache", () => {
		setCache(makeCacheKey("pat", "ts", "/p"), makeResponse());
		assert.ok(getCache(makeCacheKey("pat", "ts", "/p")) !== undefined);
		clearResultCache();
		assert.strictEqual(getCache(makeCacheKey("pat", "ts", "/p")), undefined);
	});

	it("clear on empty cache does not throw", () => {
		clearResultCache();
		assert.ok(true);
	});

	it("same key overwrites value without extra eviction", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		setCache(key, makeResponse({ details: { v: 1 } }));
		setCache(key, makeResponse({ details: { v: 2 } }));
		const got = getCache(key)!.details as Record<string, unknown>;
		assert.strictEqual(got.v, 2);
	});
});

describe("cache FIFO eviction at MAX_CACHE_SIZE", () => {
	beforeEach(() => {
		clearResultCache();
	});

	it("199 entries survive without eviction", () => {
		for (let i = 0; i < 199; i++) {
			const key = makeCacheKey(`pat${i}`, "ts", "/p");
			setCache(key, makeResponse());
		}
		// All 199 should still be present
		for (let i = 0; i < 199; i++) {
			const got = getCache(makeCacheKey(`pat${i}`, "ts", "/p"));
			assert.ok(got !== undefined, `entry ${i} should exist`);
		}
	});

	it("201st entry evicts first-inserted key (FIFO)", () => {
		// Insert MAX_CACHE_SIZE entries
		for (let i = 0; i < MAX_CACHE_SIZE; i++) {
			const key = makeCacheKey(`pat${i}`, "ts", "/p");
			setCache(key, makeResponse());
		}
		// First entry should exist
		assert.ok(getCache(makeCacheKey("pat0", "ts", "/p")) !== undefined);

		// Insert one more (201st)
		const newKey = makeCacheKey("pat-new", "ts", "/p");
		setCache(newKey, makeResponse());

		// First entry should be evicted
		assert.strictEqual(getCache(makeCacheKey("pat0", "ts", "/p")), undefined);
		// New entry should exist
		assert.ok(getCache(newKey) !== undefined);
		// Other entries (pat1 onward) should still exist
		assert.ok(getCache(makeCacheKey("pat1", "ts", "/p")) !== undefined);
	});
});
