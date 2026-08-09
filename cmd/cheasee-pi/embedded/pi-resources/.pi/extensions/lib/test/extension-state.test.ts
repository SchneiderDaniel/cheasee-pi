/**
 * Phase 1: ExtensionState store — file-backed state persistence
 *
 * Factory createExtensionStateStore() with injectable statePath,
 * typed get/set/read/write, sequential write queue, error surfacing.

 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/extension-state.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, unlink, rmdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExtensionStateStore } from "../extension-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function randomDir(): string {
	return join(tmpdir(), `extension-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
// Phase 1: ExtensionState store
// ===========================================================================

describe("ExtensionState store — factory shape", () => {
	it("createExtensionStateStore returns object with correct API shape", () => {
		const store = createExtensionStateStore("/tmp/test-state.json");
		assert.ok(typeof store.ensureStateLoaded === "function");
		assert.ok(typeof store.getState === "function");
		assert.ok(typeof store.setState === "function");
		assert.ok(typeof store.saveState === "function");
		assert.ok(typeof store.getKeys === "function");
		assert.ok(typeof store.setKey === "function");
		assert.ok(typeof store.getKey === "function");
	});

	it("default state when no file exists returns empty record {}", async () => {
		const dir = randomDir();
		await mkdir(dir, { recursive: true });
		const statePath = join(dir, "state.json");
		const store = createExtensionStateStore(statePath);
		await store.ensureStateLoaded();
		assert.deepEqual(store.getState(), {});
		await cleanDir(dir);
	});
});

describe("ExtensionState store — entity (in-memory)", () => {
	it('setKey("logger", false) then getKey("logger") returns false', () => {
		const store = createExtensionStateStore("/tmp/test.json");
		store.setKey("logger", false);
		assert.equal(store.getKey("logger"), false);
	});

	it("setState({advice: true, logger: false}) then getState() returns same object (immutable)", () => {
		const store = createExtensionStateStore("/tmp/test.json");
		store.setState({ advice: true, logger: false });
		const state = store.getState();
		assert.deepEqual(state, { advice: true, logger: false });
		// Ensure it's a copy, not reference
		state.advice = false;
		assert.equal(store.getKey("advice"), true, "getState returned mutable reference");
	});

	it("getKey for unset key returns undefined", () => {
		const store = createExtensionStateStore("/tmp/test.json");
		assert.equal(store.getKey("nonexistent"), undefined);
	});

	it("multiple keys independently settable and readable", () => {
		const store = createExtensionStateStore("/tmp/test.json");
		store.setKey("advice", true);
		store.setKey("logger", false);
		assert.equal(store.getKey("advice"), true);
		assert.equal(store.getKey("logger"), false);
	});

	it("setKey with null value clears the key", () => {
		const store = createExtensionStateStore("/tmp/test.json");
		store.setKey("advice", true);
		store.setKey("advice", null);
		assert.equal(store.getKey("advice"), undefined);
	});

	it("getKeys returns all keys", () => {
		const store = createExtensionStateStore("/tmp/test.json");
		store.setKey("advice", true);
		store.setKey("logger", false);
		const keys = store.getKeys();
		assert.deepEqual(keys.sort(), ["advice", "logger"]);
	});
});

describe("ExtensionState store — adapter (file-backed)", () => {
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

	it("saveState persists valid JSON to disk, ensureStateLoaded reads it back", async () => {
		const store = createExtensionStateStore(statePath);
		store.setKey("advice", true);
		store.setKey("logger", false);
		await store.saveState();

		// New store instance reads what was saved
		const store2 = createExtensionStateStore(statePath);
		await store2.ensureStateLoaded();
		assert.equal(store2.getKey("advice"), true);
		assert.equal(store2.getKey("logger"), false);
	});

	it("missing state file → ensureStateLoaded returns defaults, no throw", async () => {
		const store = createExtensionStateStore(statePath);
		await store.ensureStateLoaded();
		assert.deepEqual(store.getState(), {});
	});

	it("corrupt JSON in state file → ensureStateLoaded returns defaults, no throw", async () => {
		await writeFile(statePath, "not-json{{{");
		const store = createExtensionStateStore(statePath);
		await store.ensureStateLoaded();
		assert.deepEqual(store.getState(), {});
	});

	it("write to unwritable path throws EnsureVenvError-style typed error", async () => {
		const badPath = "/nonexistent-dir-xyz-123/state.json";
		const store = createExtensionStateStore(badPath);
		store.setKey("advice", true);
		await assert.rejects(
			async () => await store.saveState(),
			(err: any) => {
				return err.name === "ExtensionStateError" && err.step === "write";
			},
		);
	});

	it("concurrent saveState calls queue sequentially, no partial writes", async () => {
		const store = createExtensionStateStore(statePath);

		// Simulate multiple concurrent saves
		store.setKey("advice", true);
		const p1 = store.saveState();
		store.setKey("logger", true);
		const p2 = store.saveState();

		await Promise.all([p1, p2]);

		// Verify final state on disk
		const raw = await readFile(statePath, "utf8");
		const data = JSON.parse(raw);
		assert.equal(data.advice, true);
		assert.equal(data.logger, true);
	});

	it("ensureStateLoaded caches after first call, second call returns cached (no re-read)", async () => {
		const store = createExtensionStateStore(statePath);
		await store.ensureStateLoaded();
		assert.deepEqual(store.getState(), {});

		// Write file to disk behind store's back
		await writeFile(statePath, JSON.stringify({ advice: false }));

		// Second call should NOT re-read (cached)
		await store.ensureStateLoaded();
		assert.deepEqual(store.getState(), {}, "Should still be empty — cached");
	});
});
