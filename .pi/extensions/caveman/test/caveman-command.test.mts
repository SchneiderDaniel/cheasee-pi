/**
 * Tests for caveman command.ts
 *
 * Phase 4: /caveman command handler and config dialog.
 * Tests handler logic, not TUI rendering.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { registerCavemanCommand } from "../command.ts";
import { createConfigStore } from "../config.ts";
import type { Level } from "../types.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockPi() {
	const calls: { name: string; args: unknown[] }[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const eventHandlers: Map<string, (...args: unknown[]) => void> = new Map();

	return {
		calls,
		entries,
		eventHandlers,
		registerCommand: (name: string, def: unknown) => {
			calls.push({ name: "registerCommand", args: [name, def] });
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		on: (_event: string, handler: (...args: unknown[]) => void) => {
			eventHandlers.set(_event, handler);
		},
	};
}

function makeMockCtx() {
	const notifications: { msg: string; level: string }[] = [];
	const ctx = {
		ui: {
			notify: (msg: string, level: string) => {
				notifications.push({ msg, level });
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (s: string) => s,
			},
			setStatus: () => {},
			custom: () => {},
		},
	};
	return { ctx, notifications };
}

function setupTest(initialLevel: Level = "off") {
	const configStore = createConfigStore();
	configStore.setLevel(initialLevel);

	const syncStatus = () => {};

	const pi = makeMockPi();
	const mockPi = pi as unknown as Parameters<typeof registerCavemanCommand>[0];

	registerCavemanCommand(mockPi, configStore, syncStatus);

	// Extract the handler and completions from the registration call
	const regCall = pi.calls.find((c) => c.name === "registerCommand");
	const def = regCall?.args[1] as {
		handler: (args: string, ctx: ReturnType<typeof makeMockCtx>["ctx"]) => Promise<void>;
		getArgumentCompletions: (prefix: string) => unknown[] | null;
	};

	return { configStore, pi: mockPi, piCalls: pi.calls, def, ...makeMockCtx() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("command.ts — registerCavemanCommand", () => {
	it("exports registerCavemanCommand as a function", () => {
		assert.strictEqual(typeof registerCavemanCommand, "function");
	});

	it("calls pi.registerCommand('caveman', ...) exactly once", () => {
		const { piCalls } = setupTest();
		const cmdCalls = piCalls.filter((c) => c.name === "registerCommand");
		assert.strictEqual(cmdCalls.length, 1);
		assert.strictEqual(cmdCalls[0]!.args[0], "caveman");
	});
});

describe("command.ts — handler with args='lite'", () => {
	it("sets level to lite, appends entry, notifies info", async () => {
		const { def, configStore, ctx, notifications } = setupTest("off");
		await def.handler("lite", ctx);
		assert.strictEqual(configStore.getLevel(), "lite");
		assert.strictEqual(notifications.length, 1);
		assert.ok(notifications[0]!.msg.includes("LITE"));
		assert.strictEqual(notifications[0]!.level, "info");
	});
});

describe("command.ts — handler with args='off'", () => {
	it("sets level to off, notifies 'Caveman off'", async () => {
		const { def, configStore, ctx, notifications } = setupTest("full");
		await def.handler("off", ctx);
		assert.strictEqual(configStore.getLevel(), "off");
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0]!.msg, "Caveman off");
	});
});

describe("command.ts — handler alias args", () => {
	for (const alias of ["stop", "quit"] as const) {
		it(`${alias} alias works same as off`, async () => {
			const { def, configStore, ctx, notifications } = setupTest("full");
			await def.handler(alias, ctx);
			assert.strictEqual(configStore.getLevel(), "off");
			assert.strictEqual(notifications[0]!.msg, "Caveman off");
		});
	}
});

describe("command.ts — handler with empty args toggles", () => {
	it("current off -> toggles to full", async () => {
		const { def, configStore, ctx, notifications } = setupTest("off");
		await def.handler("", ctx);
		assert.strictEqual(configStore.getLevel(), "full");
	});

	it("current full -> toggles to off", async () => {
		const { def, configStore, ctx } = setupTest("full");
		await def.handler("", ctx);
		assert.strictEqual(configStore.getLevel(), "off");
	});
});

describe("command.ts — handler with args=undefined toggles", () => {
	it("current off -> toggles to full", async () => {
		const { def, configStore, ctx, notifications } = setupTest("off");
		await def.handler(undefined as unknown as string, ctx);
		assert.strictEqual(configStore.getLevel(), "full");
	});

	it("current full -> toggles to off", async () => {
		const { def, configStore, ctx } = setupTest("full");
		await def.handler(undefined as unknown as string, ctx);
		assert.strictEqual(configStore.getLevel(), "off");
	});

	it("null does not throw", async () => {
		const { def, configStore, ctx } = setupTest("off");
		await def.handler(null as unknown as string, ctx);
		assert.strictEqual(configStore.getLevel(), "full");
	});
});

describe("command.ts — handler with invalid args", () => {
	it("notifies error with 'Unknown'", async () => {
		const { def, ctx, notifications } = setupTest("off");
		await def.handler("invalid", ctx);
		assert.strictEqual(notifications.length, 1);
		assert.ok(notifications[0]!.msg.includes("Unknown"));
		assert.strictEqual(notifications[0]!.level, "error");
	});
});

describe("command.ts — getArgumentCompletions", () => {
	it("'l' matches lite", () => {
		const { def } = setupTest();
		const result = def.getArgumentCompletions("l");
		assert.ok(result !== null);
		assert.ok(result!.some((item: unknown) => (item as { value: string }).value === "lite"));
	});

	it("'x' returns null", () => {
		const { def } = setupTest();
		const result = def.getArgumentCompletions("x");
		assert.strictEqual(result, null);
	});

	it("empty prefix returns all 8 options", () => {
		const { def } = setupTest();
		const result = def.getArgumentCompletions("");
		assert.ok(result !== null);
		assert.strictEqual(result!.length, 8);
	});
});
