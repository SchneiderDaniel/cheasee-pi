/**
 * Tests: cache.ts — FIFO bounded cache
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import {
	clearResultCache,
	makeCacheKey,
	setCache,
	getCache,
	currentCacheEpoch,
	MAX_CACHE_SIZE,
} from "../cache.ts";
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
		const E = currentCacheEpoch();
		setCache(key, value, E);
		const got = getCache(key, E);
		assert.strictEqual(got, value);
	});

	it("round-trips structuredContent by reference (widened ExecResultResponse)", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const structuredContent = { matches: 2, results: [], language: "ts" };
		const value = makeResponse({ structuredContent });
		const E = currentCacheEpoch();
		setCache(key, value, E);
		const got = getCache(key, E)!;
		assert.deepStrictEqual(got.structuredContent, structuredContent);
		assert.strictEqual(got.structuredContent, structuredContent);
	});

	it("get returns undefined for missing key", () => {
		const got = getCache("nonexistent", currentCacheEpoch());
		assert.strictEqual(got, undefined);
	});

	it("clear empties cache", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		setCache(key, makeResponse(), currentCacheEpoch());
		assert.ok(getCache(key, currentCacheEpoch()) !== undefined);
		clearResultCache();
		assert.strictEqual(getCache(key, currentCacheEpoch()), undefined);
	});

	it("clear on empty cache does not throw", () => {
		clearResultCache();
		assert.ok(true);
	});

	it("same key + same epoch overwrites value without extra eviction", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		setCache(key, makeResponse({ details: { v: 1 } }), E);
		setCache(key, makeResponse({ details: { v: 2 } }), E);
		const got = getCache(key, E)!.details as Record<string, unknown>;
		assert.strictEqual(got.v, 2);
	});
});

describe("cache epoch semantics", () => {
	beforeEach(() => {
		clearResultCache();
	});

	it("currentCacheEpoch returns a number and is monotonic", () => {
		const a = currentCacheEpoch();
		const b = currentCacheEpoch();
		assert.strictEqual(typeof a, "number");
		assert.ok(b >= a, "epoch must never move backwards");
	});

	it("clearResultCache increments the epoch", () => {
		const E = currentCacheEpoch();
		clearResultCache();
		assert.ok(currentCacheEpoch() > E, "clear must bump the world version");
	});

	it("an entry set before clear is unreachable at the new epoch", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		setCache(key, makeResponse(), E);
		clearResultCache();
		assert.strictEqual(getCache(key, currentCacheEpoch()), undefined);
	});

	it("same epoch round-trip returns the same reference", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		const value = makeResponse();
		setCache(key, value, E);
		assert.strictEqual(getCache(key, E), value);
	});

	it("an entry at one epoch is not served at another (epoch isolation)", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		setCache(key, makeResponse(), E);
		assert.strictEqual(getCache(key, E + 1), undefined);
	});

	it("a stale in-flight write-back after clear is unreachable", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		// world changed mid-request: clear bumps the epoch
		clearResultCache();
		// the in-flight request writes back under its pre-mutation epoch
		setCache(key, makeResponse({ details: { stale: true } }), E);
		assert.strictEqual(getCache(key, currentCacheEpoch()), undefined);
	});

	it("a fresh set at the new epoch wins over a stale write-back", () => {
		const key = makeCacheKey("pat", "ts", "/p");
		const E = currentCacheEpoch();
		clearResultCache();
		const E2 = currentCacheEpoch();
		const fresh = makeResponse({ details: { fresh: true } });
		setCache(key, fresh, E2);
		// the in-flight pre-mutation search writes back late, under its old epoch
		setCache(key, makeResponse({ details: { stale: true } }), E);
		assert.strictEqual(getCache(key, E2), fresh, "fresh payload must win at the new epoch");
	});

	it("getCache for an absent key returns undefined", () => {
		assert.strictEqual(getCache("absent", currentCacheEpoch()), undefined);
	});
});

describe("cache FIFO eviction at MAX_CACHE_SIZE", () => {
	let E: number;
	beforeEach(() => {
		clearResultCache();
		E = currentCacheEpoch();
	});

	it("199 entries survive without eviction", () => {
		for (let i = 0; i < 199; i++) {
			const key = makeCacheKey(`pat${i}`, "ts", "/p");
			setCache(key, makeResponse(), E);
		}
		// All 199 should still be present
		for (let i = 0; i < 199; i++) {
			const got = getCache(makeCacheKey(`pat${i}`, "ts", "/p"), E);
			assert.ok(got !== undefined, `entry ${i} should exist`);
		}
	});

	it("201st entry evicts first-inserted key (FIFO)", () => {
		// Insert MAX_CACHE_SIZE entries
		for (let i = 0; i < MAX_CACHE_SIZE; i++) {
			const key = makeCacheKey(`pat${i}`, "ts", "/p");
			setCache(key, makeResponse(), E);
		}
		// First entry should exist
		assert.ok(getCache(makeCacheKey("pat0", "ts", "/p"), E) !== undefined);

		// Insert one more (201st)
		const newKey = makeCacheKey("pat-new", "ts", "/p");
		setCache(newKey, makeResponse(), E);

		// First entry should be evicted
		assert.strictEqual(getCache(makeCacheKey("pat0", "ts", "/p"), E), undefined);
		// New entry should exist
		assert.ok(getCache(newKey, E) !== undefined);
		// Other entries (pat1 onward) should still exist
		assert.ok(getCache(makeCacheKey("pat1", "ts", "/p"), E) !== undefined);
	});
});
