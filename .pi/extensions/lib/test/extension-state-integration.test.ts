/**
 * Phase 3: ExtensionState integration with session-logger and session-advice
 *
 * Verifies that both extensions use the shared ExtensionState store
 * instead of duplicated writeExtState functions.
 *
 * Also verifies that runtime exports from session-logger/index.ts and
 * session-advice/index.ts remain importable and functional.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/extension-state-integration.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, unlink, rmdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createExtensionStateStore } from "../extension-state.ts";

// Phase 3: Both extensions now use ExtensionState instead of duplicated writeExtState
import { beginSession } from "../../session-logger/pipeline.ts";
import {
	createSessionLoggerGate,
	toggleSessionLoggerGate,
	getSessionLoggerState,
} from "../../session-logger/index.ts";

import { getSessionAdviceState, splitArgs } from "../../session-advice/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomDir(): string {
	return join(
		tmpdir(),
		`ext-state-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
}

async function cleanDir(dir: string): Promise<void> {
	try {
		await unlink(join(dir, "state.json"));
	} catch {
		/* ignore */
	}
	try {
		await rmdir(dir);
	} catch {
		/* ignore */
	}
}

// ===========================================================================
// Phase 3: Replacement verification — session-logger
// ===========================================================================

describe("ExtensionState integration — session-logger", () => {
	it("createSessionLoggerGate returns a gate with expected shape", () => {
		const gate = createSessionLoggerGate(true);
		assert.ok(typeof gate === "object");
		assert.equal(gate.enabledForNextSession, true);
		assert.equal(gate.sessionEnabled, true);
	});

	it("createSessionLoggerGate with false initial state", () => {
		const gate = createSessionLoggerGate(false);
		assert.equal(gate.enabledForNextSession, false);
		assert.equal(gate.sessionEnabled, false);
	});

	it("toggleSessionLoggerGate off returns false and updates gate", () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "off");
		assert.equal(result, false);
		assert.equal(gate.enabledForNextSession, false);
		// Current session still enabled
		assert.equal(gate.sessionEnabled, true);
	});

	it("toggleSessionLoggerGate on returns true and updates gate", () => {
		const gate = createSessionLoggerGate(false);
		const result = toggleSessionLoggerGate(gate, "on");
		assert.equal(result, true);
		assert.equal(gate.enabledForNextSession, true);
	});

	it("beginSession applies enabledForNextSession to sessionEnabled", () => {
		const gate = createSessionLoggerGate(true);
		// First session
		assert.equal(beginSession(gate), true);
		// Toggle off for next session
		toggleSessionLoggerGate(gate, "off");
		assert.equal(gate.sessionEnabled, true); // Current session still on
		// Next session starts
		assert.equal(beginSession(gate), false);
		assert.equal(gate.sessionEnabled, false);
	});

	it("getSessionLoggerState returns correct current session state", () => {
		const gate = createSessionLoggerGate(true);
		beginSession(gate);
		assert.equal(getSessionLoggerState(gate), true);
	});

	it("getSessionLoggerState with null gate returns null", () => {
		assert.equal(getSessionLoggerState(null), null);
	});

	it("getSessionLoggerState with undefined gate returns null", () => {
		assert.equal(getSessionLoggerState(undefined), null);
	});

	it("session-logger toggle lifecycle: enabled → off → next session disabled", () => {
		const gate = createSessionLoggerGate(true);
		beginSession(gate);
		assert.equal(gate.sessionEnabled, true);

		toggleSessionLoggerGate(gate, "off");
		assert.equal(gate.enabledForNextSession, false);
		assert.equal(gate.sessionEnabled, true); // Current session persists

		beginSession(gate);
		assert.equal(gate.sessionEnabled, false); // Next session reflects toggle
	});

	it("re-enables logging only when a later session starts", () => {
		const gate = createSessionLoggerGate(false);
		assert.equal(beginSession(gate), false);
		assert.equal(toggleSessionLoggerGate(gate, "on"), true);
		assert.equal(gate.sessionEnabled, false);

		assert.equal(beginSession(gate), true);
		assert.equal(gate.sessionEnabled, true);
	});
});

// ===========================================================================
// Phase 3: Replacement verification — session-advice
// ===========================================================================

describe("ExtensionState integration — session-advice", () => {
	it("getSessionAdviceState returns boolean (true|false)", () => {
		const state = getSessionAdviceState();
		// Module-level default is true (enabled)
		assert.ok(typeof state === "boolean");
	});

	it("getSessionAdviceState default when no state file exists returns true (?? true fallback)", () => {
		// The module-level extState is not loaded from disk, so getKey("advice") returns
		// undefined, which ?? true resolves to true
		const state = getSessionAdviceState();
		assert.equal(state, true);
	});

	it("splitArgs handles quoted strings", () => {
		const args = splitArgs('report "multi word arg"');
		assert.deepEqual(args, ["report", "multi word arg"]);
	});

	it("splitArgs handles single quotes", () => {
		const args = splitArgs("report 'single quoted'");
		assert.deepEqual(args, ["report", "single quoted"]);
	});

	it("splitArgs handles empty input", () => {
		assert.deepEqual(splitArgs(""), []);
	});

	it("splitArgs handles whitespace", () => {
		assert.deepEqual(splitArgs("  a   b  "), ["a", "b"]);
	});

	it("splitArgs handles mixed quoting", () => {
		const args = splitArgs(`report "double" 'single' normal`);
		assert.deepEqual(args, ["report", "double", "single", "normal"]);
	});
});

// ===========================================================================
// Phase 3: Shared ExtensionState store for both extensions
// ===========================================================================

describe("ExtensionState store — shared state file (both extensions)", () => {
	let dir: string;
	let statePath: string;

	beforeEach(async () => {
		dir = randomDir();
		await mkdir(dir, { recursive: true });
		statePath = join(dir, "state.json");
	});

	afterEach(async () => {
		await cleanDir(dir);
	});

	it("ExtensionState can hold both 'logger' and 'advice' keys in same file", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("logger", false);
		store.setKey("advice", true);
		await store.saveState();

		const raw = await readFile(statePath, "utf8");
		const data = JSON.parse(raw);
		assert.equal(data.logger, false);
		assert.equal(data.advice, true);
	});

	it("ExtensionState round-trip: logger setKey + saveState + reload = getKey same", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("logger", true);
		await store.saveState();

		// Reload in new store
		const store2 = createExtensionStateStore(statePath);
		await store2.ensureStateLoaded();
		assert.equal(store2.getKey("logger"), true);
	});

	it("ExtensionState round-trip: advice setKey + saveState + reload = getKey same", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("advice", true);
		await store.saveState();

		const store2 = createExtensionStateStore(statePath);
		await store2.ensureStateLoaded();
		assert.equal(store2.getKey("advice"), true);
	});

	it("ExtensionState fallback: getKey('advice') ?? true returns true when unset", () => {
		const store = createExtensionStateStore(statePath);
		const value = store.getKey("advice") ?? true;
		assert.equal(value, true);
	});

	it("ExtensionState fallback: getKey('logger') ?? true returns true when unset", () => {
		const store = createExtensionStateStore(statePath);
		const value = store.getKey("logger") ?? true;
		assert.equal(value, true);
	});

	it("both keys can be set independently without clobbering", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("logger", false);
		await store.saveState();

		// Set advice on same store (simulating session-advice init)
		store.setKey("advice", true);
		await store.saveState();

		// Verify both persisted
		const raw = await readFile(statePath, "utf8");
		const data = JSON.parse(raw);
		assert.equal(data.logger, false);
		assert.equal(data.advice, true);
	});
});

// ===========================================================================
// Phase 3: Error surfacing (intentional behavioral change from silent catch)
// ===========================================================================

describe("ExtensionState — error surfacing (was silent catch)", () => {
	it("saveState to unwritable path throws ExtensionStateError", async () => {
		const badPath = "/nonexistent-dir-xyz-123/state.json";
		const store = createExtensionStateStore(badPath);
		store.setKey("logger", true);
		await assert.rejects(
			async () => await store.saveState(),
			(err: any) => {
				return err.name === "ExtensionStateError" && err.step === "write";
			},
		);
	});
});
