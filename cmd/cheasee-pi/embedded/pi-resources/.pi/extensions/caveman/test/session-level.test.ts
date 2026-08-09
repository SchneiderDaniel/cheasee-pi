/**
 * Session-level resolver tests for caveman
 *
 * Pure function tests for resolveSessionLevel, resetSessionLevel,
 * and shouldAppendCavemanEntry — moved from lib/test/extension-state.test.ts
 * to break the lib↔caveman circular dependency.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/caveman/test/session-level.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveSessionLevel,
	resetSessionLevel,
	shouldAppendCavemanEntry,
	type SessionEntry,
} from "../session-level.ts";
import type { Level } from "../types.ts";
import type { CavemanConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(level: Level): SessionEntry {
	return { type: "custom", customType: "caveman-level", data: { level } };
}

function config(overrides: Partial<CavemanConfig> = {}): CavemanConfig {
	return { defaultLevel: "lite", showStatus: true, ...overrides };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("resolveSessionLevel (pure function)", () => {
	it("new session, defaultLevel=off, empty entries → off, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), []);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("new session, defaultLevel=lite, empty entries → lite, shouldAppendEntry=true", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), []);
		assert.equal(result.level, "lite");
		assert.equal(result.shouldAppendEntry, true);
	});

	it("new session, defaultLevel=full, empty entries → full, shouldAppendEntry=true", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), []);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, true);
	});

	it("resume session, defaultLevel=off, session entry full → full, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), [entry("full")]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("resume session, defaultLevel=lite, session entry ultra → ultra, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [entry("ultra")]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("resume session, defaultLevel=full, session entry off → off, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [entry("off")]);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("new session, defaultLevel=off, empty entries → shouldAppendEntry=false (no off entry logged)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), []);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("session entries contain non-caveman entries only → treats as new session, applies defaultLevel", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [
			{ type: "custom", customType: "other-type", data: { foo: "bar" } },
		]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, true);
	});

	it("Bug #475 regression: multiple level changes lite→full→ultra → returns ultra (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			entry("lite"),
			entry("full"),
			entry("ultra"),
		]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("Bug #475: multiple level changes lite→full → returns full (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			entry("lite"),
			entry("full"),
		]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("Bug #475: multiple level changes full→ultra→off → returns off (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [
			entry("full"),
			entry("ultra"),
			entry("off"),
		]);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("interleaved: non-caveman entries between level changes → returns last caveman-level", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			{ type: "custom", customType: "other-type", data: { foo: "bar" } },
			entry("lite"),
			{ type: "custom", customType: "other-type", data: { baz: "qux" } },
			entry("full"),
			{ type: "custom", customType: "text-message", data: { text: "some message" } },
			entry("ultra"),
		]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("single entry: resume with one caveman-level entry → returns that level", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [entry("full")]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});
});

describe("resetSessionLevel (session_shutdown)", () => {
	it("resets from full to off", () => {
		assert.equal(resetSessionLevel("full"), "off");
	});

	it("resets from ultra to off", () => {
		assert.equal(resetSessionLevel("ultra"), "off");
	});

	it("idempotent: resetting off returns off", () => {
		assert.equal(resetSessionLevel("off"), "off");
	});
});

describe("shouldAppendCavemanEntry — pure function", () => {
	it("shouldAppendEntry=true, isTrusted=true → returns true", () => {
		assert.equal(shouldAppendCavemanEntry(true, true), true);
	});

	it("shouldAppendEntry=true, isTrusted=false → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(true, false), false);
	});

	it("shouldAppendEntry=false, isTrusted=true → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(false, true), false);
	});

	it("shouldAppendEntry=false, isTrusted=false → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(false, false), false);
	});
});
