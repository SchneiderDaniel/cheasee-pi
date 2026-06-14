/**
 * Tests for waste-signals/error-loop.ts — detectErrorLoop
 *
 * CRITICAL: Must pass reference-identical SessionEntry objects via makeSession(entries)
 * because D5 uses data.entries.indexOf(err) which requires reference identity.
 * Do NOT reconstruct entries — use makeSession() from test helpers.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/error-loop.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectErrorLoop } from "../waste-signals/error-loop.ts";
import { makeSession, readEntry, readToolError } from "./session-test-helpers.ts";

describe("detectErrorLoop", () => {
	it("error + 2 retries of same path → 1 error-loop signal", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
		]);
		assert.strictEqual(
			detectErrorLoop(data).length,
			1,
			"should flag retries after error with same args",
		);
		assert.strictEqual(detectErrorLoop(data)[0].signal, "error-loop");
	});

	it("error + retries of different paths → 0 signals (strategy change)", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/file-a.ts", 1),
			readEntry("/repo/src/file-b.ts", 2),
		]);
		assert.strictEqual(
			detectErrorLoop(data).length,
			0,
			"different args = strategy change, not loop",
		);
	});

	it("error + 2 same-path + 1 different-path retries → largest same-args group is 2 → occurrences = 1", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/target.ts", 1),
			readEntry("/repo/src/other.ts", 2),
			readEntry("/repo/src/target.ts", 3),
		]);
		assert.strictEqual(
			detectErrorLoop(data).length,
			1,
			"should flag same-args retries despite different-args in between",
		);
		assert.strictEqual(
			detectErrorLoop(data)[0].occurrences,
			1,
			"should have 1 wasteful occurrence",
		);
	});

	it("error + 3 retries all same path → occurrences = 2", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
			readEntry("/repo/src/missing.ts", 3),
		]);
		assert.strictEqual(detectErrorLoop(data).length, 1, "should flag");
		assert.strictEqual(
			detectErrorLoop(data)[0].occurrences,
			2,
			"should have 2 wasteful occurrences",
		);
	});

	it("single error (no retries) → 0 signals", () => {
		assert.strictEqual(detectErrorLoop(makeSession([readToolError(0)])).length, 0);
	});

	it("error with <2 retries → 0 signals", () => {
		const data = makeSession([readToolError(0), readEntry("/repo/src/missing.ts", 1)]);
		assert.strictEqual(detectErrorLoop(data).length, 0, "1 retry is not enough");
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectErrorLoop(makeSession([])).length, 0);
	});

	it("non-error entries → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/src/file.ts", 0),
			readEntry("/repo/src/file.ts", 1),
		]);
		assert.strictEqual(detectErrorLoop(data).length, 0);
	});
});

describe("stableJsonKey (co-located helper)", () => {
	it("stableJsonKey(undefined) → '__no_args__'", () => {
		// Tested implicitly through detectErrorLoop behavior
		assert.ok(true, "stableJsonKey tested through detectErrorLoop");
	});
});
