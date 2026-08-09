/**
 * Tests for session-logger toggle args normalization (Bug 1 fix)
 *
 * Documents toggleSessionLoggerGate behavior with raw unnormalized input.
 * The fix is in the handler layer (index.ts) which normalizes args with
 * trim + toLowerCase before calling this function.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-toggle.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { beginSession } from "../pipeline.ts";
import { createSessionLoggerGate, toggleSessionLoggerGate } from "../index.ts";

// ---------------------------------------------------------------------------
// Phase 1: Toggle args normalization
// ---------------------------------------------------------------------------

describe("toggleSessionLoggerGate — normalized args", () => {
	it('"on" returns true, gate.enabledForNextSession = true', () => {
		const gate = createSessionLoggerGate(false);
		const result = toggleSessionLoggerGate(gate, "on");
		assert.strictEqual(result, true);
		assert.strictEqual(gate.enabledForNextSession, true);
	});

	it('"off" returns false, gate.enabledForNextSession = false', () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "off");
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});
});

describe("toggleSessionLoggerGate — unnormalized args (documents bug behavior)", () => {
	it('"ON" (uppercase) does not match "on", falls through to toggle', () => {
		const gate = createSessionLoggerGate(false);
		const result = toggleSessionLoggerGate(gate, "ON");
		// Toggles from false to true because "ON" !== "on"
		assert.strictEqual(result, true);
		assert.strictEqual(gate.enabledForNextSession, true);
	});

	it('"Off" (mixed case) toggles instead of matching "off"', () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "Off");
		// Toggles from true to false because "Off" !== "off"
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});

	it('"off " (trailing space) toggles instead of matching "off"', () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "off ");
		// Toggles from true to false because "off " !== "off"
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});
});

describe("toggleSessionLoggerGate — edge cases", () => {
	it("undefined toggles (catch-all path)", () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, undefined);
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});

	it('"" (empty string) toggles', () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "");
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});

	it('"unknown" toggles (flips from true to false)', () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "unknown");
		// Falls through to toggle: flips true -> false
		assert.strictEqual(result, false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});
});

describe("toggleSessionLoggerGate — regression: existing gate lifecycle", () => {
	it("start enabled -> toggle off -> next session disabled", () => {
		const gate = createSessionLoggerGate(true);
		assert.strictEqual(beginSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(toggleSessionLoggerGate(gate, "off"), false);
		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(beginSession(gate), false);
		assert.strictEqual(gate.sessionEnabled, false);
	});

	it("start disabled -> toggle on -> next session enabled", () => {
		const gate = createSessionLoggerGate(false);
		assert.strictEqual(beginSession(gate), false);

		assert.strictEqual(toggleSessionLoggerGate(gate, "on"), true);
		assert.strictEqual(gate.enabledForNextSession, true);
		assert.strictEqual(gate.sessionEnabled, false);

		assert.strictEqual(beginSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);
	});
});
