/**
 * Phase 3: ExtensionState integration with session-logger
 *
 * Verifies that the shared ExtensionState store is used
 * instead of duplicated writeExtState functions.
 *
 * Also verifies that runtime exports from session-logger/index.ts
 * remain importable and functional.
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
import { createSessionLoggerGate, toggleSessionLoggerGate } from "../../session-logger/index.ts";

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
// Phase 3: Replacement verification
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
// Phase 3: Shared ExtensionState store
// ===========================================================================

describe("ExtensionState store — shared state file", () => {
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

	it("ExtensionState can hold 'logger' key", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("logger", false);
		await store.saveState();

		const raw = await readFile(statePath, "utf8");
		const data = JSON.parse(raw);
		assert.equal(data.logger, false);
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

	it("ExtensionState fallback: getKey('logger') ?? true returns true when unset", () => {
		const store = createExtensionStateStore(statePath);
		const value = store.getKey("logger") ?? true;
		assert.equal(value, true);
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
