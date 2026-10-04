/**
 * Tests for session-logger/nested.ts — pure nested-tool-call folds.
 *
 * Covers the three public helpers:
 *   deriveParentToolCallId  — recover `<parent>` from a `<parent>/<n>` nested id
 *   rollupNestedCalls       — fold a NestedToolCalls record into call/error/duration counts
 *   classifyIncomplete      — distinguish dropped / arguments-omitted / unfinished
 *
 * The runtime `tool_execution_*` extension events do NOT carry parentToolCallId
 * (pi 1.0.2 strips it in _emitExtensionEvent), so attribution is derived from the
 * id suffix. These tests assert the derivation path only.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-nested.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	deriveParentToolCallId,
	rollupNestedCalls,
	classifyIncomplete,
} from "../nested.ts";

// ═══════════════════════════════════════════════════════════════════════
// Implementation export references (satisfy TDD gate: test-covers-symbols)
// ═══════════════════════════════════════════════════════════════════════

describe("nested.ts exports", () => {
	it("deriveParentToolCallId is a callable export", () => {
		assert.strictEqual(typeof deriveParentToolCallId, "function");
	});
	it("rollupNestedCalls is a callable export", () => {
		assert.strictEqual(typeof rollupNestedCalls, "function");
	});
	it("classifyIncomplete is a callable export", () => {
		assert.strictEqual(typeof classifyIncomplete, "function");
	});
});

// ── deriveParentToolCallId ──────────────────────────────────────────

describe("deriveParentToolCallId", () => {
	it("recovers parent from a one-level nested id", () => {
		assert.strictEqual(deriveParentToolCallId("codemode_1/1"), "codemode_1");
	});

	it("slices at the LAST slash for recursive chains", () => {
		assert.strictEqual(deriveParentToolCallId("codemode_1/1/1"), "codemode_1/1");
	});

	it("returns undefined for a top-level id (no slash)", () => {
		assert.strictEqual(deriveParentToolCallId("call_abc123"), undefined);
	});

	it("returns undefined for an empty id", () => {
		assert.strictEqual(deriveParentToolCallId(""), undefined);
	});
});

// ── rollupNestedCalls ───────────────────────────────────────────────

describe("rollupNestedCalls", () => {
	it("returns zeroes for an empty record", () => {
		assert.deepStrictEqual(rollupNestedCalls({ calls: [], complete: true }), {
			nestedCalls: 0,
			nestedErrors: 0,
			nestedDurationMs: 0,
		});
	});

	it("sums calls, errors and durations", () => {
		const record = {
			calls: [
				{ id: "codemode_1/1", name: "read", status: "ok" as const, durationMs: 120 },
				{ id: "codemode_1/2", name: "grep", status: "error" as const, durationMs: 30 },
			],
			complete: true,
		};
		assert.deepStrictEqual(rollupNestedCalls(record), {
			nestedCalls: 2,
			nestedErrors: 1,
			nestedDurationMs: 150,
		});
	});

	it("counts unfinished but not as error and contributes zero duration", () => {
		const record = {
			calls: [{ id: "codemode_1/1", name: "read", status: "unfinished" as const }],
			complete: false,
		};
		assert.deepStrictEqual(rollupNestedCalls(record), {
			nestedCalls: 1,
			nestedErrors: 0,
			nestedDurationMs: 0,
		});
	});
});

// ── classifyIncomplete ──────────────────────────────────────────────

describe("classifyIncomplete", () => {
	it("returns undefined when complete is true", () => {
		const record = {
			calls: [{ id: "codemode_1/1", name: "read", status: "ok" as const, durationMs: 5 }],
			complete: true,
		};
		assert.strictEqual(classifyIncomplete(record), undefined);
	});

	it("returns arguments-omitted when a call has argumentsBytes but no arguments", () => {
		const record = {
			calls: [
				{ id: "codemode_1/1", name: "read", status: "ok" as const, argumentsBytes: 9000 },
			],
			complete: false,
		};
		assert.strictEqual(classifyIncomplete(record), "arguments-omitted");
	});

	it("returns unfinished when a call is still running", () => {
		const record = {
			calls: [{ id: "codemode_1/1", name: "read", status: "unfinished" as const }],
			complete: false,
		};
		assert.strictEqual(classifyIncomplete(record), "unfinished");
	});

	it("returns dropped when complete is false with no other cause", () => {
		const record = {
			calls: [{ id: "codemode_1/1", name: "read", status: "ok" as const }],
			complete: false,
		};
		assert.strictEqual(classifyIncomplete(record), "dropped");
	});

	it("returns dropped when complete is false and calls is empty", () => {
		assert.strictEqual(classifyIncomplete({ calls: [], complete: false }), "dropped");
	});
});
