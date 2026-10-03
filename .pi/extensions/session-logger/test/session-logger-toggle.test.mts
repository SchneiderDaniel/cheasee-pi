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
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginSession } from "../pipeline.ts";
import defaultExport, { createSessionLoggerGate, toggleSessionLoggerGate } from "../index.ts";

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

// ===========================================================================
// Phase 3: /session-logger command — UI-capability guard (ctx.hasUI)
// ===========================================================================

function captureCommand(): { name: string; opts: any } {
	const commands: Array<{ name: string; opts: any }> = [];
	const pi = {
		on: () => {},
		registerCommand: (name: string, opts: any) => {
			commands.push({ name, opts });
		},
		getSessionName: () => "test-session",
	};
	defaultExport(pi as any);
	return commands.find((c) => c.name === "session-logger")!;
}

describe("index.ts /session-logger command — hasUI guard", () => {
	let dir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		dir = mkdtempSync(join(tmpdir(), "sl-toggle-guard-"));
		process.chdir(dir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	function statePath(): string {
		return join(dir, ".pi", "state", "session-extensions.json");
	}

	it("hasUI true — notify called exactly once with ON/OFF info", async () => {
		const cmd = captureCommand();
		const calls: Array<{ msg: string; type: string }> = [];
		await cmd.opts.handler("off", {
			hasUI: true,
			ui: { notify: (msg: string, type: string) => calls.push({ msg, type }) },
		});
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].msg.includes("OFF"));
		assert.strictEqual(calls[0].type, "info");
	});

	it("RPC-equivalent (hasUI true, no TUI) — notify IS called", async () => {
		const cmd = captureCommand();
		const calls: Array<{ msg: string; type: string }> = [];
		await cmd.opts.handler("on", {
			hasUI: true,
			ui: { notify: (msg: string, type: string) => calls.push({ msg, type }) },
		});
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].msg.includes("ON"));
	});

	it("hasUI false — notify spy call count is 0 (not merely a no-throw)", async () => {
		const cmd = captureCommand();
		const calls: Array<{ msg: string; type: string }> = [];
		await cmd.opts.handler("on", {
			hasUI: false,
			ui: { notify: (msg: string, type: string) => calls.push({ msg, type }) },
		});
		assert.strictEqual(calls.length, 0, "notify must not be attempted without UI");
		assert.strictEqual(JSON.parse(readFileSync(statePath(), "utf8")).logger, true, "preference still persisted");
	});

	it("hasUI true + saveState throws — error AND info notify both fire", async () => {
		// A plain file where the state dir should be forces mkdir to fail.
		writeFileSync(join(dir, ".pi"), "not a dir", "utf8");
		const cmd = captureCommand();
		const calls: Array<{ msg: string; type: string }> = [];
		await cmd.opts.handler("on", {
			hasUI: true,
			ui: { notify: (msg: string, type: string) => calls.push({ msg, type }) },
		});
		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].type, "error");
		assert.strictEqual(calls[1].type, "info");
	});

	it("hasUI false + saveState throws — notify is 0 and handler resolves", async () => {
		writeFileSync(join(dir, ".pi"), "not a dir", "utf8");
		const cmd = captureCommand();
		const calls: Array<{ msg: string; type: string }> = [];
		await cmd.opts.handler("off", {
			hasUI: false,
			ui: { notify: (msg: string, type: string) => calls.push({ msg, type }) },
		});
		assert.strictEqual(calls.length, 0);
	});
});
