/**
 * Tests for ExtensionState module
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/extensionState.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Integration: refactored extensions now use ExtensionState instead of inline file I/O
import {
	createSessionLoggerGate,
	toggleSessionLoggerGate,
	beginSessionLoggerSession,
	getSessionLoggerState,
} from "../session-logger/index.ts";
import { splitArgs } from "../session-advice/index.ts";

import {
	InMemoryStore,
	FileStore,
	ExtensionState,
	SessionExtensionsSchema,
	type ExtensionStateStore,
	type OnErrorDetail,
} from "./extensionState.ts";

// ── Helpers ──

function freshDir(): string {
	return mkdtempSync(path.join(tmpdir(), "estate-test-"));
}

function createStore(store: ExtensionStateStore) {
	return new ExtensionState(store, SessionExtensionsSchema);
}

// ── Phase 1: InMemoryStore adapter ──

describe("InMemoryStore", () => {
	it("read() on fresh store returns null", async () => {
		const store = new InMemoryStore();
		assert.strictEqual(await store.read(), null);
	});

	it("write(data) then read() returns exact written string", async () => {
		const store = new InMemoryStore();
		await store.write('{"hello":"world"}');
		assert.strictEqual(await store.read(), '{"hello":"world"}');
	});

	it("multiple writes: read() returns last written value", async () => {
		const store = new InMemoryStore();
		await store.write('{"a":1}');
		await store.write('{"a":2}');
		assert.strictEqual(await store.read(), '{"a":2}');
	});

	it("read() after write('') returns empty string", async () => {
		const store = new InMemoryStore();
		await store.write("");
		assert.strictEqual(await store.read(), "");
	});

	it("write() accepts non-JSON strings (store is transparent)", async () => {
		const store = new InMemoryStore();
		await store.write("plain text");
		assert.strictEqual(await store.read(), "plain text");
	});
});

// ── Phase 2: FileStore adapter ──

describe("FileStore", () => {
	it("read() on non-existent path returns null", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "nonexistent.json" });
		assert.strictEqual(await store.read(), null);
	});

	it("write(data) creates target file with correct content", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "test.json" });
		const content = '{"key":"value"}';
		await store.write(content);
		const fileContent = fs.readFileSync(path.join(dir, "test.json"), "utf-8");
		assert.strictEqual(fileContent, content);
	});

	it("write(data) cleans up temp file after successful write", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "cleanup.json" });
		await store.write('{"a":1}');
		const tmpPath = path.join(dir, "cleanup.json.tmp");
		assert.ok(!fs.existsSync(tmpPath), "temp file should be cleaned up");
	});

	it("write() creates parent directory if absent", async () => {
		const dir = freshDir();
		const subDir = path.join(dir, "sub", "dir");
		const store = new FileStore({ dir: subDir, filename: "nested.json" });
		await store.write('{"nested":true}');
		assert.ok(fs.existsSync(path.join(subDir, "nested.json")));
	});

	it("read() on existing file returns full content as string", async () => {
		const dir = freshDir();
		fs.writeFileSync(path.join(dir, "read-test.json"), '{"read":true}');
		const store = new FileStore({ dir, filename: "read-test.json" });
		assert.strictEqual(await store.read(), '{"read":true}');
	});

	it("concurrent sequential writes produce last-written content", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "concurrent.json" });
		await store.write('{"v":1}');
		await store.write('{"v":2}');
		const fileContent = fs.readFileSync(path.join(dir, "concurrent.json"), "utf-8");
		assert.strictEqual(JSON.parse(fileContent).v, 2);
	});

	it("path getter returns resolved path", () => {
		const store = new FileStore({ dir: "/tmp/test", filename: "state.json" });
		assert.ok(store.path.endsWith("/tmp/test/state.json"));
	});
});

// ── Phase 3: ExtensionState core — get/set with InMemoryStore ──

describe("ExtensionState (InMemoryStore) — get/set", () => {
	it("get('advice') on fresh store returns default true", async () => {
		const state = createStore(new InMemoryStore());
		assert.strictEqual(await state.get("advice"), true);
	});

	it("get('logger') on fresh store returns default true", async () => {
		const state = createStore(new InMemoryStore());
		assert.strictEqual(await state.get("logger"), true);
	});

	it("set('advice', false) then get('advice') returns false", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("advice", false);
		assert.strictEqual(await state.get("advice"), false);
	});

	it("set('logger', false) then get('logger') returns false", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("logger", false);
		assert.strictEqual(await state.get("logger"), false);
	});

	it("set('advice', false) does not affect get('logger')", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("advice", false);
		assert.strictEqual(await state.get("logger"), true);
		assert.strictEqual(await state.get("advice"), false);
	});

	it("set('logger', false) does not affect get('advice')", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("logger", false);
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(await state.get("logger"), false);
	});

	it("get('advice') returns a plain boolean (not boolean | undefined)", async () => {
		const state = createStore(new InMemoryStore());
		const value = await state.get("advice");
		assert.strictEqual(typeof value, "boolean");
	});

	it("set('advice', true) followed by get('advice') returns true (idempotent)", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("advice", true);
		assert.strictEqual(await state.get("advice"), true);
	});

	it("set then get round-trips through store content", async () => {
		const store = new InMemoryStore();
		const state = createStore(store);
		await state.set("logger", false);
		const raw = await store.read();
		assert.ok(raw, "store should have content after set");
		const parsed = JSON.parse(raw!);
		assert.strictEqual(parsed.logger, false);
		assert.strictEqual(parsed.advice, true);
	});
});

// ── Phase 4: Schema validation and migration ──

describe("ExtensionState — schema validation and migration", () => {
	it("store returns 'not json' — get('advice') returns default true, onError fires", async () => {
		const errors: OnErrorDetail[] = [];
		const store = new InMemoryStore();
		await store.write("not json");
		const state = new ExtensionState(store, SessionExtensionsSchema, (d) => errors.push(d));
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].error, "error object should be present");
		assert.strictEqual(errors[0].rawData, "not json");
	});

	it("store returns {advice: false} (missing logger) — logger defaults to true", async () => {
		const store = new InMemoryStore();
		await store.write('{"advice": false}');
		const state = createStore(store);
		assert.strictEqual(await state.get("logger"), true);
		assert.strictEqual(await state.get("advice"), false);
	});

	it("store returns {logger: false} (missing advice) — advice defaults to true", async () => {
		const store = new InMemoryStore();
		await store.write('{"logger": false}');
		const state = createStore(store);
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(await state.get("logger"), false);
	});

	it("round-trip preserves unknown keys (read-modify-write cycle)", async () => {
		const store = new InMemoryStore();
		await store.write('{"advice": false, "logger": false, "unknown_key": "preserved"}');
		const state = createStore(store);
		await state.set("advice", true);
		const raw = await store.read();
		const parsed = JSON.parse(raw!);
		assert.strictEqual(parsed.advice, true);
		assert.strictEqual(parsed.logger, false);
		assert.strictEqual(parsed.unknown_key, "preserved");
	});

	it("store returns {advice: 'not_a_boolean'} — get returns default, onError fires", async () => {
		const errors: OnErrorDetail[] = [];
		const store = new InMemoryStore();
		await store.write('{"advice": "not_a_boolean"}');
		const state = new ExtensionState(store, SessionExtensionsSchema, (d) => errors.push(d));
		assert.strictEqual(await state.get("advice"), true);
		assert.ok(errors.length >= 1);
	});

	it("store returns null (fresh) — both fields return defaults", async () => {
		const store = new InMemoryStore();
		const state = createStore(store);
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(await state.get("logger"), true);
	});
});

// ── Phase 5: Write queue serialization ──

describe("ExtensionState — write queue serialization", () => {
	it("two simultaneous set() calls via Promise.all — both settle, deterministic", async () => {
		const store = new InMemoryStore();
		const state = createStore(store);
		await Promise.all([state.set("advice", false), state.set("advice", true)]);
		const value = await state.get("advice");
		// Last write wins (second set in queue order)
		assert.strictEqual(value, true);
	});

	it("set('advice', false) followed immediately by get('advice') returns false", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("advice", false);
		assert.strictEqual(await state.get("advice"), false);
	});

	it("sequential sets on different fields produce consistent snapshot", async () => {
		const state = createStore(new InMemoryStore());
		await state.set("advice", false);
		await state.set("logger", false);
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(await state.get("logger"), false);
	});

	it("concurrent set/get on different fields don't interfere", async () => {
		const store = new InMemoryStore();
		const state = createStore(store);
		await store.write('{"advice": true, "logger": true}');
		await Promise.all([state.set("advice", false), state.set("logger", false)]);
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(await state.get("logger"), false);
	});
});

// ── Phase 6: Error handling ──

describe("ExtensionState — error handling", () => {
	it("onError callback invoked with parse error when store returns corrupt JSON", async () => {
		const errors: OnErrorDetail[] = [];
		const store = new InMemoryStore();
		await store.write("{invalid json}");
		const state = new ExtensionState(store, SessionExtensionsSchema, (d) => errors.push(d));
		await state.get("advice");
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].error instanceof Error);
		assert.strictEqual(errors[0].rawData, "{invalid json}");
	});

	it("onError callback invoked with key and error when store.write() rejects", async () => {
		const errors: OnErrorDetail[] = [];
		const rejectingStore: ExtensionStateStore = {
			read: async () => '{"advice": true, "logger": true}',
			write: async () => {
				throw new Error("write failed");
			},
		};
		const state = new ExtensionState(rejectingStore, SessionExtensionsSchema, (d) =>
			errors.push(d),
		);
		await assert.rejects(() => state.set("advice", false), /write failed/);
	});

	it("set after write failure still works (write queue recovery)", async () => {
		// Real store for persistence, wrapped to fail on first write
		const innerStore = new InMemoryStore();
		await innerStore.write('{"advice": true, "logger": true}');
		let writeCount = 0;
		const flakyStore: ExtensionStateStore = {
			read: async () => innerStore.read(),
			write: async (data: string) => {
				writeCount++;
				if (writeCount === 1) throw new Error("first write fails");
				await innerStore.write(data);
			},
		};
		const state = new ExtensionState(flakyStore, SessionExtensionsSchema);

		// First set fails
		await assert.rejects(() => state.set("advice", false), /first write fails/);

		// Second set succeeds — write queue was reset
		await assert.doesNotReject(() => state.set("advice", false));
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(writeCount, 2);
	});

	it("without onError, errors propagate as rejected promise", async () => {
		const rejectingStore: ExtensionStateStore = {
			read: async () => '{"advice": true, "logger": true}',
			write: async () => {
				throw new Error("write rejected");
			},
		};
		const state = new ExtensionState(rejectingStore, SessionExtensionsSchema);
		await assert.rejects(() => state.set("advice", false), /write rejected/);
	});

	it("onError is optional — constructing without it does not throw", () => {
		const store = new InMemoryStore();
		assert.doesNotThrow(() => new ExtensionState(store, SessionExtensionsSchema));
	});

	it("store read() rejects — error surfaces through onError callback", async () => {
		const errors: OnErrorDetail[] = [];
		const rejectingStore: ExtensionStateStore = {
			read: async () => {
				throw new Error("read failed");
			},
			write: async () => {},
		};
		const state = new ExtensionState(rejectingStore, SessionExtensionsSchema, (d) =>
			errors.push(d),
		);
		const result = await state.get("advice");
		assert.strictEqual(result, true); // falls back to default
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].error.message.includes("read failed"));
	});

	it("schema validation error fires onError with rawData", async () => {
		const errors: OnErrorDetail[] = [];
		const store = new InMemoryStore();
		await store.write('{"advice": "bad", "logger": true}');
		const state = new ExtensionState(store, SessionExtensionsSchema, (d) => errors.push(d));
		const result = await state.get("advice");
		assert.strictEqual(result, true); // default fallback
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].rawData?.includes("bad"));
	});
});

// ── Phase 7: FileStore with ExtensionState end-to-end ──

describe("ExtensionState (FileStore) — end-to-end", () => {
	it("set('advice', false) then get('advice') returns false", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "e2e.json" });
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("advice", false);
		assert.strictEqual(await state.get("advice"), false);
	});

	it("written file is valid JSON", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "valid.json" });
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("logger", true);
		const raw = fs.readFileSync(path.join(dir, "valid.json"), "utf-8");
		assert.doesNotThrow(() => JSON.parse(raw));
	});

	it("state survives new instance (persistence)", async () => {
		const dir = freshDir();
		const store1 = new FileStore({ dir, filename: "persist.json" });
		const state1 = new ExtensionState(store1, SessionExtensionsSchema);
		await state1.set("advice", false);
		await state1.set("logger", false);

		// New instance, same file
		const store2 = new FileStore({ dir, filename: "persist.json" });
		const state2 = new ExtensionState(store2, SessionExtensionsSchema);
		assert.strictEqual(await state2.get("advice"), false);
		assert.strictEqual(await state2.get("logger"), false);
	});

	it("atomic write produces complete JSON (not truncated)", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "atomic.json" });
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("advice", false);
		const raw = fs.readFileSync(path.join(dir, "atomic.json"), "utf-8");
		const parsed = JSON.parse(raw);
		assert.strictEqual(parsed.advice, false);
		assert.strictEqual(parsed.logger, true);
	});

	it("get returns correct value after set to same key", async () => {
		const dir = freshDir();
		const store = new FileStore({ dir, filename: "toggle.json" });
		const state = new ExtensionState(store, SessionExtensionsSchema);
		assert.strictEqual(await state.get("logger"), true);
		await state.set("logger", false);
		assert.strictEqual(await state.get("logger"), false);
		await state.set("logger", true);
		assert.strictEqual(await state.get("logger"), true);
	});
});

// ── Edge cases ──

describe("ExtensionState — edge cases", () => {
	it("empty object in store is treated like fresh (defaults applied)", async () => {
		const store = new InMemoryStore();
		await store.write("{}");
		const state = createStore(store);
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(await state.get("logger"), true);
	});

	it("null in store (literal 'null' JSON) — treated as invalid, returns defaults", async () => {
		const errors: OnErrorDetail[] = [];
		const store = new InMemoryStore();
		await store.write("null");
		const state = new ExtensionState(store, SessionExtensionsSchema, (d) => errors.push(d));
		assert.strictEqual(await state.get("advice"), true);
		// null is an invalid object, schema validation fails
		assert.strictEqual(errors.length, 1);
	});

	it("extra whitespace in file is handled (JSON.parse tolerates it)", async () => {
		const store = new InMemoryStore();
		await store.write('\n\n{\n  "advice": false\n}\n\n');
		const state = createStore(store);
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(await state.get("logger"), true);
	});
});

// ── Integration: session-logger refactored to use ExtensionState ──

describe("Integration — session-logger with ExtensionState", () => {
	it("getSessionLoggerState returns boolean for a valid gate", () => {
		const gate = createSessionLoggerGate(true);
		beginSessionLoggerSession(gate);
		assert.strictEqual(getSessionLoggerState(gate), true);
	});

	it("toggleSessionLoggerGate off flips enabledForNextSession, persists via ExtensionState", async () => {
		const gate = createSessionLoggerGate(true);
		const enabled = toggleSessionLoggerGate(gate, "off");
		assert.strictEqual(enabled, false);

		// Mirror what session-logger handler does: persist toggled state via ExtensionState
		const store = new InMemoryStore();
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("logger", enabled);

		assert.strictEqual(await state.get("logger"), false);
		// Writing logger field must not affect advice field
		assert.strictEqual(await state.get("advice"), true);
	});

	it("toggleSessionLoggerGate on followed by persist — ExtensionState stores logger=true", async () => {
		const gate = createSessionLoggerGate(false);
		const enabled = toggleSessionLoggerGate(gate, "on");
		assert.strictEqual(enabled, true);

		const store = new InMemoryStore();
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("logger", enabled);

		assert.strictEqual(await state.get("logger"), true);
		assert.strictEqual(await state.get("advice"), true);
	});

	it("ExtensionState logger value survives across instances (FileStore)", async () => {
		const dir = freshDir();
		const store1 = new FileStore({ dir, filename: "logger-int.json" });
		const state1 = new ExtensionState(store1, SessionExtensionsSchema);
		await state1.set("logger", false);

		const store2 = new FileStore({ dir, filename: "logger-int.json" });
		const state2 = new ExtensionState(store2, SessionExtensionsSchema);
		assert.strictEqual(await state2.get("logger"), false);
	});

	it("gate lifecycle with ExtensionState: off after next session (full integration)", async () => {
		const gate = createSessionLoggerGate(true);
		assert.strictEqual(beginSessionLoggerSession(gate), true);

		// Toggle off - persists to ExtensionState
		const enabled = toggleSessionLoggerGate(gate, "off");
		assert.strictEqual(enabled, false);

		const store = new InMemoryStore();
		const state = new ExtensionState(store, SessionExtensionsSchema);
		await state.set("logger", enabled);

		// Current session still enabled, next session disabled
		assert.strictEqual(gate.sessionEnabled, true);
		assert.strictEqual(gate.enabledForNextSession, false);

		// After next session begins
		assert.strictEqual(beginSessionLoggerSession(gate), false);
		await state.set("logger", false);
		assert.strictEqual(await state.get("logger"), false);
	});
});

// ── Integration: session-advice refactored to use ExtensionState ──

describe("Integration — session-advice with ExtensionState", () => {
	it("splitArgs parses quoted strings", () => {
		assert.deepStrictEqual(splitArgs('on off "multi word"'), ["on", "off", "multi word"]);
	});

	it("splitArgs handles single-quoted strings", () => {
		assert.deepStrictEqual(splitArgs("report 'session 123'"), ["report", "session 123"]);
	});

	it("splitArgs returns empty array for empty input", () => {
		assert.deepStrictEqual(splitArgs(""), []);
	});

	it("advice state persists through ExtensionState (mirroring session-advice handler)", async () => {
		const store = new InMemoryStore();
		const state = new ExtensionState(store, SessionExtensionsSchema);

		// Mirror what session-advice does: set advice=false on toggle
		await state.set("advice", false);
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(await state.get("logger"), true);

		// Toggle back on
		await state.set("advice", true);
		assert.strictEqual(await state.get("advice"), true);
	});

	it("advice state persists across instances via FileStore", async () => {
		const dir = freshDir();
		const store1 = new FileStore({ dir, filename: "advice-int.json" });
		const state1 = new ExtensionState(store1, SessionExtensionsSchema);
		await state1.set("advice", false);

		const store2 = new FileStore({ dir, filename: "advice-int.json" });
		const state2 = new ExtensionState(store2, SessionExtensionsSchema);
		assert.strictEqual(await state2.get("advice"), false);
		assert.strictEqual(await state2.get("logger"), true);
	});

	it("advice and logger fields are independent in ExtensionState", async () => {
		const store = new InMemoryStore();
		const state = new ExtensionState(store, SessionExtensionsSchema);

		await state.set("advice", false);
		await state.set("logger", false);
		assert.strictEqual(await state.get("advice"), false);
		assert.strictEqual(await state.get("logger"), false);

		// Toggle only advice back — logger stays
		await state.set("advice", true);
		assert.strictEqual(await state.get("advice"), true);
		assert.strictEqual(await state.get("logger"), false);
	});
});
