/**
 * Tests for session-logger persisted-state hydration (bug #1735)
 *
 * Persisted `/session-logger off` was written to
 * `.pi/state/session-extensions.json` but never read back — every restart
 * defaulted the gate to ON. These tests pin the hydrate rule
 * (persisted wins, absent → true) and the no-clobber guarantee.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-hydration.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import defaultExport, {
	createSessionLoggerGate,
	hydrateSessionLoggerGate,
} from "../index.ts";
import { beginSession } from "../pipeline.ts";
import { createExtensionStateStore } from "../../lib/extension-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statePathFor(dir: string): string {
	return join(dir, ".pi", "state", "session-extensions.json");
}

async function writeStateRaw(dir: string, content: string): Promise<void> {
	await mkdir(join(dir, ".pi", "state"), { recursive: true });
	await writeFile(statePathFor(dir), content, "utf8");
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

function createMockPi(): {
	pi: any;
	handlers: Array<{ event: string; fn: (...args: any[]) => Promise<void> }>;
	commands: Array<{ name: string; opts: any }>;
} {
	const handlers: Array<{ event: string; fn: (...args: any[]) => Promise<void> }> = [];
	const commands: Array<{ name: string; opts: any }> = [];
	const pi = {
		on: (event: string, fn: (...args: any[]) => Promise<void>) => {
			handlers.push({ event, fn });
		},
		registerCommand: (name: string, opts: any) => {
			commands.push({ name, opts });
		},
		getSessionName: () => "test-session",
	};
	return { pi, handlers, commands };
}

function createSessionStartCtx(sessionFile: string, cwd: string): any {
	return {
		mode: "tui",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
			getEntries: () => [],
		},
	};
}

// ===========================================================================
// Phase 1: Hydration rule (hydrateSessionLoggerGate)
// ===========================================================================

describe("hydrateSessionLoggerGate — persisted-wins rule", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sl-hydrate-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("persisted false overrides default-ON gate (core bug)", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: false }));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(beginSession(gate), false);
	});

	it("persisted true overrides default-OFF gate (persisted-wins both directions)", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: true }));
		const gate = createSessionLoggerGate(false);

		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(gate.enabledForNextSession, true);
		assert.strictEqual(beginSession(gate), true);
	});

	it("absent key → default-ON preserved", async () => {
		await writeStateRaw(dir, JSON.stringify({}));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(beginSession(gate), true);
	});

	it("missing state file (ENOENT) → default-ON", async () => {
		const gate = createSessionLoggerGate(true);
		await hydrateSessionLoggerGate(
			gate,
			createExtensionStateStore(join(dir, "does-not-exist", "state.json")),
		);
		assert.strictEqual(beginSession(gate), true);
	});

	it("null value → default-ON (nullish ?? true)", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: null }));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(beginSession(gate), true);
	});

	it("hydration sets enabledForNextSession but does not promote sessionEnabled", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: false }));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(gate.enabledForNextSession, false);
		// Promotion is beginSession's job — hydration must not short-circuit it.
		assert.strictEqual(gate.sessionEnabled, true);
	});

	it("reads only the logger key; other keys untouched in memory and on disk", async () => {
		await writeStateRaw(dir, JSON.stringify({ advice: false, logger: false }));
		const store = createExtensionStateStore(statePathFor(dir));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, store);
		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(store.getKey("advice"), false);

		await store.saveState();
		const raw = JSON.parse(await readFile(statePathFor(dir), "utf8"));
		assert.strictEqual(raw.advice, false);
		assert.strictEqual(raw.logger, false);
	});

	it("performs a real disk read (persist via store A, hydrate via new store B)", async () => {
		const storeA = createExtensionStateStore(statePathFor(dir));
		storeA.setKey("logger", false);
		await storeA.saveState();

		const gate = createSessionLoggerGate(true);
		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));

		assert.strictEqual(beginSession(gate), false);
	});

	it("is idempotent (write-once store cache); gate value stable", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: false }));
		const store = createExtensionStateStore(statePathFor(dir));
		const gate = createSessionLoggerGate(true);

		await hydrateSessionLoggerGate(gate, store);
		await hydrateSessionLoggerGate(gate, store);

		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(beginSession(gate), false);
	});
});

// ===========================================================================
// Phase 4: Error paths & boundaries (fail-open, no throw)
// ===========================================================================

describe("hydrateSessionLoggerGate — fail-open error paths", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sl-hydrate-err-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("corrupt JSON → default-ON, no throw", async () => {
		await writeStateRaw(dir, "{ not json");
		const gate = createSessionLoggerGate(true);
		await assert.doesNotReject(async () => {
			await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));
		});
		assert.strictEqual(beginSession(gate), true);
	});

	it("empty file → default-ON, no throw", async () => {
		await writeStateRaw(dir, "");
		const gate = createSessionLoggerGate(true);
		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));
		assert.strictEqual(beginSession(gate), true);
	});

	it("unreadable path (statePath is a directory) → default-ON, no throw", async () => {
		await mkdir(statePathFor(dir), { recursive: true });
		const gate = createSessionLoggerGate(true);
		await assert.doesNotReject(async () => {
			await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));
		});
		assert.strictEqual(beginSession(gate), true);
	});

	for (const [label, value] of [
		["string", "yes"],
		["number", 1],
		["object", { enabled: false }],
		["array", []],
	] as const) {
		it(`non-boolean value (logger is ${label}) → default-ON, no throw`, async () => {
			await writeStateRaw(dir, JSON.stringify({ logger: value }));
			const gate = createSessionLoggerGate(true);
			await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));
			// Malformed state must not violate the gate's boolean contract.
			assert.strictEqual(gate.enabledForNextSession, true);
			assert.strictEqual(beginSession(gate), true);
		});
	}

	it("non-boolean persisted value overrides a default-OFF gate → default-ON", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: "yes" }));
		const gate = createSessionLoggerGate(false);
		await hydrateSessionLoggerGate(gate, createExtensionStateStore(statePathFor(dir)));
		assert.strictEqual(gate.enabledForNextSession, true);
		assert.strictEqual(beginSession(gate), true);
	});
});

// ===========================================================================
// Phase 2 + 5: No-clobber on load & user journey across restart
// ===========================================================================

describe("session-logger persisted state — module load & restart", () => {
	let dir: string;
	let originalCwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sl-restart-"));
		originalCwd = process.cwd();
		process.chdir(dir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await rm(dir, { recursive: true, force: true });
	});

	it("module load does not clobber persisted state", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: false }));

		const { pi } = createMockPi();
		defaultExport(pi);

		const raw = JSON.parse(await readFile(statePathFor(dir), "utf8"));
		assert.strictEqual(raw.logger, false);
	});

	it("session_start does not rewrite a persisted false", async () => {
		await writeStateRaw(dir, JSON.stringify({ logger: false }));
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const start = handlers.find((h) => h.event === "session_start")!;
		await start.fn({}, createSessionStartCtx(join(dir, ".pi", "sessions", "current.jsonl"), dir));

		const raw = JSON.parse(await readFile(statePathFor(dir), "utf8"));
		assert.strictEqual(raw.logger, false);
	});

	it("persisted false survives restart: /session-logger off → restart → stays OFF (no symlink)", async () => {
		const sessionsDir = join(dir, ".pi", "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "current.jsonl");
		await writeFile(sessionFile, "", "utf8");

		// Instance 1 — user turns logging off.
		const notifyCalls: Array<{ msg: string; type: string }> = [];
		const first = createMockPi();
		defaultExport(first.pi);
		const cmd = first.commands.find((c) => c.name === "session-logger")!;
		await cmd.opts.handler("off", {
			ui: { notify: (msg: string, type: string) => notifyCalls.push({ msg, type }) },
		});

		assert.ok(
			notifyCalls.some((c) => c.msg.includes("OFF")),
			"toggle should notify OFF",
		);
		assert.strictEqual(JSON.parse(await readFile(statePathFor(dir), "utf8")).logger, false);

		// Instance 2 — restart (fresh process in same cwd).
		const second = createMockPi();
		defaultExport(second.pi);
		const start = second.handlers.find((h) => h.event === "session_start")!;
		await start.fn({}, createSessionStartCtx(sessionFile, dir));

		assert.strictEqual(
			await pathExists(join(sessionsDir, "latest.jsonl")),
			false,
			"logging must stay OFF after restart — no latest.jsonl symlink",
		);
	});

	it("persisted true / absent → session_start creates latest.jsonl (happy path unchanged)", async () => {
		const sessionsDir = join(dir, ".pi", "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "current.jsonl");
		await writeFile(sessionFile, "", "utf8");

		const { pi, handlers } = createMockPi();
		defaultExport(pi);
		const start = handlers.find((h) => h.event === "session_start")!;
		await start.fn({}, createSessionStartCtx(sessionFile, dir));

		assert.strictEqual(
			await pathExists(join(sessionsDir, "latest.jsonl")),
			true,
			"default-ON should still create the symlink",
		);
	});

	it("restart after /session-logger on: logging re-enabled and persisted true", async () => {
		const sessionsDir = join(dir, ".pi", "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "current.jsonl");
		await writeFile(sessionFile, "", "utf8");
		await writeStateRaw(dir, JSON.stringify({ logger: false }));

		const notifyCalls: Array<{ msg: string; type: string }> = [];
		const first = createMockPi();
		defaultExport(first.pi);
		const cmd = first.commands.find((c) => c.name === "session-logger")!;
		await cmd.opts.handler("on", {
			ui: { notify: (msg: string, type: string) => notifyCalls.push({ msg, type }) },
		});

		assert.ok(
			notifyCalls.some((c) => c.msg.includes("ON")),
			"toggle should notify ON",
		);
		assert.strictEqual(JSON.parse(await readFile(statePathFor(dir), "utf8")).logger, true);

		const second = createMockPi();
		defaultExport(second.pi);
		const start = second.handlers.find((h) => h.event === "session_start")!;
		await start.fn({}, createSessionStartCtx(sessionFile, dir));

		assert.strictEqual(
			await pathExists(join(sessionsDir, "latest.jsonl")),
			true,
			"logging must be ON after restart",
		);
	});
});
