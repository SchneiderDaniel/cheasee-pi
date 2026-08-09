/**
 * Tests for TimedMap — generic timed map with TTL, max-entries, and decay
 *
 * These tests cover the generic building block.
 * Specialized behavior (batch awareness, composite-key) is tested
 * through AgentHarness.handleToolCall() integration tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TimedMap } from "./timed-map.ts";

// ── Basic get/set ──

describe("TimedMap", () => {
	it("get returns null for missing key", () => {
		const map = new TimedMap<string, string>();
		assert.equal(map.get("missing"), null);
	});

	it("set then get returns value", () => {
		const map = new TimedMap<string, string>();
		map.set("key1", "value1");
		assert.equal(map.get("key1"), "value1");
	});

	it("set overwrites existing key", () => {
		const map = new TimedMap<string, string>();
		map.set("key1", "old");
		map.set("key1", "new");
		assert.equal(map.get("key1"), "new");
	});

	it("get returns null after delete", () => {
		const map = new TimedMap<string, string>();
		map.set("key1", "value1");
		map.delete("key1");
		assert.equal(map.get("key1"), null);
	});

	it("delete is a no-op for non-existent key", () => {
		const map = new TimedMap<string, string>();
		map.delete("nonexistent"); // Should not throw
		assert.equal(map.get("nonexistent"), null);
	});
});

// ── Turn-based TTL ──

describe("TimedMap — turn-based TTL", () => {
	it("get returns value when within TTL", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("key1", "value1", 0);
		map.turn = 2;
		assert.equal(map.get("key1"), "value1");
	});

	it("get returns null when at TTL boundary (turn diff >= ttlTurns)", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("key1", "value1", 0);
		map.turn = 3;
		assert.equal(map.get("key1"), null);
	});

	it("get returns null when past TTL", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("key1", "value1", 0);
		map.turn = 10;
		assert.equal(map.get("key1"), null);
	});

	it("get with explicit currentTurn overrides internal turn", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("key1", "value1", 0);
		map.turn = 2;
		// Pass explicit turn beyond TTL — entry should be expired
		assert.equal(map.get("key1", 10), null, "should be expired with explicit turn=10");
		// Entry was deleted by the explicit-turn get above
		assert.equal(map.get("key1"), null, "entry was deleted by explicit-turn get");
		// Verify that explicit currentTurn can also PREVENT expiry
		const map2 = new TimedMap<string, string>({ ttlTurns: 3 });
		map2.set("key1", "value1", 0);
		map2.turn = 10;
		// Explicit currentTurn (2) overrides internal turn (10)
		assert.equal(map2.get("key1", 2), "value1", "explicit recent turn bypasses internal old turn");
	});

	it("different keys have independent TTL tracking", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("early", "gone", 0);
		map.set("late", "here", 5);
		map.turn = 7;
		assert.equal(map.get("early"), null, "early entry should be expired");
		assert.equal(map.get("late"), "here", "late entry should still be valid");
	});
});

// ── Time-based TTL ──

describe("TimedMap — time-based TTL", () => {
	it("get returns value when within time TTL", () => {
		const map = new TimedMap<string, string>({ ttlMs: 1000 });
		map.set("key1", "value1");
		assert.equal(map.get("key1"), "value1");
	});

	it("get returns null when past time TTL", () => {
		const map = new TimedMap<string, string>({ ttlMs: 100 });
		const realNow = Date.now;
		try {
			Date.now = () => 1000;
			map.set("key1", "value1");
			Date.now = () => 1200; // 200ms > 100ms TTL
			assert.equal(map.get("key1"), null);
		} finally {
			Date.now = realNow;
		}
	});

	it("time-based TTL with set using explicit turn (turn not affecting time TTL)", () => {
		const map = new TimedMap<string, string>({ ttlMs: 100 });
		const realNow = Date.now;
		try {
			Date.now = () => 1000;
			map.set("key1", "value1", 5);
			Date.now = () => 1050; // 50ms, within TTL
			assert.equal(map.get("key1"), "value1");
			// Verify stored turn
			assert.equal(map.turn, 0); // default turn, not affected by set
		} finally {
			Date.now = realNow;
		}
	});
});

// ── Max entries eviction ──

describe("TimedMap — max-entries eviction", () => {
	it("evicts oldest entry by turn when over maxEntries", () => {
		const map = new TimedMap<string, string>({ maxEntries: 2 });
		map.set("a", "1", 0);
		map.set("b", "2", 1);
		map.set("c", "3", 2); // a should be evicted (oldest turn)
		assert.equal(map.get("a"), null, "oldest entry 'a' should be evicted");
		assert.equal(map.get("b"), "2");
		assert.equal(map.get("c"), "3");
	});

	it("preserves entries when within maxEntries", () => {
		const map = new TimedMap<string, string>({ maxEntries: 5 });
		map.set("a", "1", 0);
		map.set("b", "2", 1);
		map.set("c", "3", 2);
		assert.equal(map.get("a"), "1");
		assert.equal(map.get("b"), "2");
		assert.equal(map.get("c"), "3");
	});

	it("evicts oldest when set is called multiple times near limit", () => {
		const map = new TimedMap<string, string>({ maxEntries: 3 });
		map.set("a", "1", 0);
		map.set("b", "2", 1);
		map.set("c", "3", 2);
		map.set("d", "4", 3); // evicts a
		map.set("e", "5", 4); // evicts b
		assert.equal(map.get("a"), null);
		assert.equal(map.get("b"), null);
		assert.equal(map.get("c"), "3");
		assert.equal(map.get("d"), "4");
		assert.equal(map.get("e"), "5");
	});
});

// ── Clear ──

describe("TimedMap — clear", () => {
	it("clear removes all entries", () => {
		const map = new TimedMap<string, string>();
		map.set("a", "1");
		map.set("b", "2");
		map.clear();
		assert.equal(map.get("a"), null);
		assert.equal(map.get("b"), null);
	});

	it("clear resets size to 0", () => {
		const map = new TimedMap<string, string>();
		map.set("a", "1");
		map.set("b", "2");
		map.clear();
		assert.equal(map.size, 0);
	});

	it("clear on empty map is a no-op", () => {
		const map = new TimedMap<string, string>();
		map.clear(); // Should not throw
		assert.equal(map.size, 0);
	});
});

// ── Decay ──

describe("TimedMap — decay", () => {
	it("decay shifts 1 from each array value", () => {
		const map = new TimedMap<string, number[]>();
		map.set("a", [1, 2, 3]);
		map.set("b", [4, 5]);
		map.decay();
		assert.deepEqual(map.get("a"), [2, 3]);
		assert.deepEqual(map.get("b"), [5]);
	});

	it("decay on empty array is a no-op", () => {
		const map = new TimedMap<string, number[]>();
		map.set("a", []);
		map.decay();
		assert.deepEqual(map.get("a"), []);
	});

	it("decay on single-element array leaves empty array", () => {
		const map = new TimedMap<string, number[]>();
		map.set("a", [42]);
		map.decay();
		assert.deepEqual(map.get("a"), []);
	});

	it("decay on non-array values is a no-op", () => {
		const map = new TimedMap<string, string>();
		map.set("a", "hello");
		map.set("b", "world");
		map.decay(); // Should not throw
		assert.equal(map.get("a"), "hello");
		assert.equal(map.get("b"), "world");
	});

	it("decay on mixed array/non-array values only affects arrays", () => {
		const map = new TimedMap<string, unknown>();
		map.set("arr", [1, 2, 3]);
		map.set("str", "hello");
		map.decay();
		assert.deepEqual(map.get("arr"), [2, 3], "array values decayed");
		assert.equal(map.get("str"), "hello", "non-array values untouched");
	});
});

// ── Entries and size ──

describe("TimedMap — entries and size", () => {
	it("entries returns all non-expired entries", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("a", "1", 2); // turn diff 3 → expired
		map.set("b", "2", 3); // turn diff 2 → valid
		map.set("c", "3", 5); // turn diff 0 → valid
		map.turn = 5;
		const entries = map.entries();
		assert.equal(entries.length, 2);
		assert.deepEqual(entries, [
			["b", "2"],
			["c", "3"],
		]);
	});

	it("entries on empty map returns []", () => {
		const map = new TimedMap<string, string>();
		assert.deepEqual(map.entries(), []);
	});

	it("size returns count of non-expired entries", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("a", "1", 0);
		map.set("b", "2", 1);
		map.turn = 5;
		assert.equal(map.size, 0); // both expired
		map.set("c", "3", 5);
		assert.equal(map.size, 1); // only c is current
	});

	it("size is 0 on empty map", () => {
		const map = new TimedMap<string, string>();
		assert.equal(map.size, 0);
	});
});

// ── Peek ──

describe("TimedMap — peek", () => {
	it("peek returns value without TTL check", () => {
		const map = new TimedMap<string, string>({ ttlTurns: 3 });
		map.set("a", "value", 0);
		map.turn = 10;
		// peek bypasses TTL check
		assert.equal(map.peek("a"), "value", "peek should bypass TTL");
		// get checks TTL and returns null (expired)
		assert.equal(map.get("a"), null, "get should check TTL");
	});

	it("peek returns null for missing key", () => {
		const map = new TimedMap<string, string>();
		assert.equal(map.peek("missing"), null);
	});

	it("peek returns null after delete", () => {
		const map = new TimedMap<string, string>();
		map.set("a", "value");
		map.delete("a");
		assert.equal(map.peek("a"), null);
	});
});

// ─── Turn management ─────────────────────────────────────────────

describe("TimedMap — turn management", () => {
	it("turn starts at 0", () => {
		const map = new TimedMap<string, string>();
		assert.equal(map.turn, 0);
	});

	it("turn can be set externally", () => {
		const map = new TimedMap<string, string>();
		map.turn = 42;
		assert.equal(map.turn, 42);
	});
});
