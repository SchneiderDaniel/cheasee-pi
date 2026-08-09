/**
 * Phase 1: config-ui helper functions (domain layer)
 * Phase 2: command.ts dispatches "config" to openConfigDialog (use-case layer)
 *
 * Extracts applySettingChange and cycleSelectedValue as pure functions
 * from config-ui.ts, and verifies command handler delegates correctly.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { CavemanConfig } from "../types.ts";
import type { ConfigStore } from "../config.ts";
import { LEVELS } from "../types.ts";
import { registerCavemanCommand } from "../command.ts";

// We import the pure functions inline via dynamic import after module mock
// Since Node 22 doesn't support mock.module(), we test behavioral contracts

// ---------------------------------------------------------------------------
// Phase 1: applySettingChange — pure function
// ---------------------------------------------------------------------------

describe("applySettingChange (pure function)", () => {
	let defaultConfig: CavemanConfig;

	beforeEach(() => {
		defaultConfig = { defaultLevel: "lite", showStatus: true };
	});

	it('accepts valid defaultLevel="ultra"', async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("defaultLevel", "ultra", defaultConfig);
		assert.notEqual(result, null);
		assert.equal(result!.defaultLevel, "ultra");
		assert.equal(result!.showStatus, true);
	});

	it('accepts valid defaultLevel="off"', async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("defaultLevel", "off", defaultConfig);
		assert.notEqual(result, null);
		assert.equal(result!.defaultLevel, "off");
	});

	it('rejects invalid defaultLevel="gibberish" — returns null', async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("defaultLevel", "gibberish", defaultConfig);
		assert.equal(result, null);
	});

	it('accepts showStatus="on" — sets showStatus=true', async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const config = { defaultLevel: "full" as const, showStatus: false };
		const result = applySettingChange("showStatus", "on", config);
		assert.notEqual(result, null);
		assert.equal(result!.showStatus, true);
		assert.equal(result!.defaultLevel, "full");
	});

	it('accepts showStatus="off" — sets showStatus=false', async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("showStatus", "off", defaultConfig);
		assert.notEqual(result, null);
		assert.equal(result!.showStatus, false);
	});

	it("rejects unknown id — returns null", async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("unknown", "x", defaultConfig);
		assert.equal(result, null);
	});

	it("returns a new object, does not mutate the input", async () => {
		const { applySettingChange } = await import("../config-ui.ts");
		const result = applySettingChange("defaultLevel", "ultra", defaultConfig);
		assert.notEqual(result, defaultConfig);
		assert.equal(defaultConfig.defaultLevel, "lite");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: cycleSelectedValue — pure function
// ---------------------------------------------------------------------------

describe("cycleSelectedValue (pure function)", () => {
	it("with 2 values, currentValue at index 0, direction=1 → returns index 1", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [
			{ id: "showStatus", label: "Status", currentValue: "on", values: ["on", "off"] },
		];
		const result = cycleSelectedValue(items, 0, 1);
		assert.equal(result, 1);
	});

	it("with 2 values, currentValue at index 1, direction=1 → returns 0 (forward wraps)", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [
			{ id: "showStatus", label: "Status", currentValue: "off", values: ["on", "off"] },
		];
		const result = cycleSelectedValue(items, 0, 1);
		assert.equal(result, 0);
	});

	it("with 2 values, currentValue at index 0, direction=-1 → returns 1 (backward wraps)", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [
			{ id: "showStatus", label: "Status", currentValue: "on", values: ["on", "off"] },
		];
		const result = cycleSelectedValue(items, 0, -1);
		assert.equal(result, 1);
	});

	it("when item has no values array → returns -1 (no-op)", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [{ id: "no-values", label: "No Values", currentValue: "x" }];
		const result = cycleSelectedValue(items, 0, 1);
		assert.equal(result, -1);
	});

	it("when items array is empty → returns -1 (no-op)", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [];
		const result = cycleSelectedValue(items, 0, 1);
		assert.equal(result, -1);
	});

	it("when selectedIndex is out of bounds → returns -1 (no-op)", async () => {
		const { cycleSelectedValue } = await import("../config-ui.ts");
		const items: SettingItem[] = [{ id: "s", label: "S", currentValue: "a", values: ["a", "b"] }];
		const result = cycleSelectedValue(items, 5, 1);
		assert.equal(result, -1);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: command handler dispatches correctly
// ---------------------------------------------------------------------------

describe("registerCavemanCommand handler dispatch", () => {
	let capturedHandler: ((args: string, ctx: any) => Promise<void>) | null;
	let mockConfigStore: ConfigStore & {
		ensureConfigLoadedCalls: number;
		setLevelCalls: string[];
		getLevelCalls: number;
		currentLevel: string;
		config: { defaultLevel: string; showStatus: boolean };
	};
	let mockPi: any;
	let syncStatusCalls: number;
	let appendEntryCalls: any[];

	beforeEach(() => {
		capturedHandler = null;
		appendEntryCalls = [];
		syncStatusCalls = 0;

		mockConfigStore = {
			ensureConfigLoadedCalls: 0,
			setLevelCalls: [] as string[],
			getLevelCalls: 0,
			currentLevel: "off",
			config: { defaultLevel: "lite", showStatus: true },

			ensureConfigLoaded: async function () {
				(this as any).ensureConfigLoadedCalls++;
			},
			getLevel: function () {
				(this as any).getLevelCalls++;
				return (this as any).currentLevel;
			},
			setLevel: function (level: string) {
				(this as any).setLevelCalls.push(level);
				(this as any).currentLevel = level;
			},
			getConfig: function () {
				return (this as any).config;
			},
			saveConfig: async function () {},
		} as any;

		mockPi = {
			registerCommand: (_name: string, config: any) => {
				capturedHandler = config.handler;
			},
			appendEntry: (_type: string, data: any) => {
				appendEntryCalls.push(data);
			},
		};

		const syncStatus = () => {
			syncStatusCalls++;
		};

		registerCavemanCommand(mockPi, mockConfigStore as any, syncStatus);
	});

	function makeCtx(): any {
		return {
			ui: {
				notify: () => {},
			},
		};
	}

	it('handler with arg="config" calls ensureConfigLoaded (delegates to openConfigDialog)', async () => {
		assert.notEqual(capturedHandler, null);
		const ctx = makeCtx();

		// openConfigDialog calls ensureConfigLoaded first
		try {
			await capturedHandler!("config", ctx);
		} catch {
			// The TUI dialog can't fully render outside a real terminal,
			// but ensureConfigLoaded should be called before any TUI code
		}

		// At minimum, ensureConfigLoaded was invoked (first thing openConfigDialog does)
		assert.ok(
			mockConfigStore.ensureConfigLoadedCalls > 0,
			"ensureConfigLoaded should be called for config arg",
		);
	});

	it('handler with arg="" (toggle) changes level, does NOT call ensureConfigLoaded', async () => {
		assert.notEqual(capturedHandler, null);

		// Starting from "off"
		mockConfigStore.currentLevel = "off";
		await capturedHandler!("", makeCtx());

		assert.equal(mockConfigStore.setLevelCalls.length, 1);
		assert.equal(mockConfigStore.setLevelCalls[0], "full"); // toggle off→full
		assert.equal(
			mockConfigStore.ensureConfigLoadedCalls,
			0,
			"ensureConfigLoaded should NOT be called for toggle",
		);
	});

	it('handler with arg="full" sets level to "full", does NOT call ensureConfigLoaded', async () => {
		assert.notEqual(capturedHandler, null);

		await capturedHandler!("full", makeCtx());

		assert.equal(mockConfigStore.setLevelCalls.length, 1);
		assert.equal(mockConfigStore.setLevelCalls[0], "full");
		assert.equal(
			mockConfigStore.ensureConfigLoadedCalls,
			0,
			"ensureConfigLoaded should NOT be called for level set",
		);
	});

	it('handler with arg="off" sets level to "off", does NOT call ensureConfigLoaded', async () => {
		assert.notEqual(capturedHandler, null);

		await capturedHandler!("off", makeCtx());

		assert.equal(mockConfigStore.setLevelCalls.length, 1);
		assert.equal(mockConfigStore.setLevelCalls[0], "off");
		assert.equal(mockConfigStore.ensureConfigLoadedCalls, 0);
	});

	it('handler with arg="stop" sets level to "off"', async () => {
		assert.notEqual(capturedHandler, null);

		await capturedHandler!("stop", makeCtx());

		assert.equal(mockConfigStore.setLevelCalls.length, 1);
		assert.equal(mockConfigStore.setLevelCalls[0], "off");
	});

	it('handler with arg="quit" sets level to "off"', async () => {
		assert.notEqual(capturedHandler, null);

		await capturedHandler!("quit", makeCtx());

		assert.equal(mockConfigStore.setLevelCalls.length, 1);
		assert.equal(mockConfigStore.setLevelCalls[0], "off");
	});

	it("handler with unknown arg notifies and does NOT change level", async () => {
		assert.notEqual(capturedHandler, null);

		const notifications: string[] = [];
		const ctx = {
			ui: {
				notify: (msg: string) => {
					notifications.push(msg);
				},
			},
		};

		await capturedHandler!("bogus", ctx);

		assert.equal(mockConfigStore.setLevelCalls.length, 0, "no level change for unknown arg");
		assert.ok(notifications.length > 0, "user should be notified of unknown arg");
	});
});
