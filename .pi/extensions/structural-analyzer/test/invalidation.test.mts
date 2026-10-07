/**
 * Tests: invalidation.ts — mutation predicate + registration
 *
 * Pure predicate truth table plus the pi wiring contract. No pi mock beyond
 * an on() recorder; no filesystem, no real handlers.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/structural-analyzer/test/invalidation.test.mts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MUTATING_TOOL_NAMES,
	isMutatingToolResult,
	registerCacheInvalidation,
} from "../invalidation.ts";

describe("MUTATING_TOOL_NAMES", () => {
	it("contains exactly write and edit", () => {
		assert.deepStrictEqual([...MUTATING_TOOL_NAMES].sort(), ["edit", "write"]);
	});

	it("multiedit is absent (documented extension seam)", () => {
		assert.ok(!MUTATING_TOOL_NAMES.has("multiedit"));
	});
});

describe("isMutatingToolResult", () => {
	const rows: Array<[Record<string, unknown>, boolean]> = [
		[{ toolName: "write", isError: false }, true],
		[{ toolName: "edit", isError: false }, true],
		[{ toolName: "write", isError: true }, false],
		[{ toolName: "edit", isError: true }, false],
		[{ toolName: "read" }, false],
		[{ toolName: "grep" }, false],
		[{ toolName: "find" }, false],
		[{ toolName: "ls" }, false],
		[{ toolName: "bash" }, false],
		[{ toolName: "structural_search" }, false],
		[{ toolName: undefined }, false],
		[{}, false],
	];

	for (const [event, expected] of rows) {
		it(`${JSON.stringify(event)} -> ${expected}`, () => {
			assert.strictEqual(isMutatingToolResult(event), expected);
		});
	}

	it("is pure: same input twice -> same result", () => {
		const event = { toolName: "write", isError: false };
		assert.strictEqual(isMutatingToolResult(event), isMutatingToolResult(event));
	});
});

describe("registerCacheInvalidation", () => {
	function makePi(): { pi: any; onCalls: Array<{ event: string; handler: Function }> } {
		const onCalls: Array<{ event: string; handler: Function }> = [];
		const pi = {
			on: (event: string, handler: Function) => {
				onCalls.push({ event, handler });
			},
		};
		return { pi, onCalls };
	}

	it("registers exactly one tool_result and one session_start, zero session_shutdown", () => {
		const { pi, onCalls } = makePi();
		registerCacheInvalidation(pi);
		const events = onCalls.map((c) => c.event);
		assert.strictEqual(events.filter((e) => e === "tool_result").length, 1);
		assert.strictEqual(events.filter((e) => e === "session_start").length, 1);
		assert.strictEqual(events.filter((e) => e === "session_shutdown").length, 0);
	});
});
