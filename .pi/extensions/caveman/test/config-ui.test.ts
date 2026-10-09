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
import { registerCavemanCommand } from "../command.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
				// The config arg opens the dialog; capture the factory without invoking it.
				custom: () => undefined,
			},
		};
	}

	it('handler with arg="config" calls ensureConfigLoaded (delegates to openConfigDialog)', async () => {
		assert.notEqual(capturedHandler, null);
		const ctx = makeCtx();

		// openConfigDialog calls ensureConfigLoaded first (no swallowed errors).
		await capturedHandler!("config", ctx);

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

// ---------------------------------------------------------------------------
// Phase 2/3: openConfigDialog renders the header via theme.style()
// ---------------------------------------------------------------------------

/** The real Theme singleton installed by initTheme() (not re-exported from the index). */
function activeThemeSingleton(): any {
	const theme = (globalThis as Record<symbol, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	assert.ok(theme, "initTheme() must run before reading the theme singleton");
	return theme;
}

/** A spy Theme that records style/fg/bold calls made by the dialog. */
function makeSentinelTheme() {
	const styleCalls: Array<{ text: string; options: { fg?: string; bold?: boolean } }> = [];
	const fgCalls: string[] = [];
	const boldCalls: string[] = [];
	const theme: any = {
		name: "sentinel",
		sourcePath: undefined,
		style: (text: string, options: { fg?: string; bold?: boolean }) => {
			styleCalls.push({ text, options });
			return `[S:${options.fg ?? ""}${options.bold ? ":bold" : ""}]${text}`;
		},
		fg: (_color: string, text: string) => {
			fgCalls.push(text);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => {
			boldCalls.push(text);
			return text;
		},
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor" as const,
		getThinkingBorderColor: () => (text: string) => text,
		getBashModeBorderColor: () => (text: string) => text,
	};
	return { theme, styleCalls, fgCalls, boldCalls };
}

/** Invoke openConfigDialog, capture `ctx.ui.custom`'s factory, and render the component. */
async function renderConfigDialog(theme: any): Promise<any> {
	const store: any = {
		ensureConfigLoaded: async () => {},
		getConfig: () => ({ defaultLevel: "lite", showStatus: true }),
		saveConfig: async () => {},
	};
	let factory: any = null;
	const ctx: any = {
		ui: {
			notify: () => {},
			custom: (f: any) => {
				factory = f;
			},
		},
	};
	const { openConfigDialog } = await import("../config-ui.ts");
	await openConfigDialog(ctx, store, () => {});
	assert.ok(factory, "ctx.ui.custom factory must be captured");
	return factory({ requestRender: () => {} }, theme, {}, () => {});
}

describe("openConfigDialog header styling", () => {
	beforeEach(() => {
		initTheme(); // system theme, no file watcher
	});

	it("styles the header with theme.style (AC 1) and keeps no nested fg/bold (AC 2)", async () => {
		const sentinel = makeSentinelTheme();
		const component = await renderConfigDialog(sentinel.theme);

		const headerStyles = sentinel.styleCalls.filter((c) => c.text === " Caveman Config");
		assert.equal(headerStyles.length, 1, "header must be styled exactly once via theme.style");
		assert.deepEqual(headerStyles[0]!.options, { fg: "accent", bold: true });
		assert.equal(sentinel.boldCalls.length, 0, "theme.bold() must not be called");
		assert.ok(
			!sentinel.fgCalls.includes(" Caveman Config"),
			"header must not be composed with theme.fg",
		);

		const wide = component.render(120);
		assert.ok(
			String(wide[0]).includes("[S:accent:bold] Caveman Config"),
			`header line should reflect the style marker, got: ${wide[0]}`,
		);
	});

	it("renders without throwing at narrow and wide widths", async () => {
		const sentinel = makeSentinelTheme();
		const component = await renderConfigDialog(sentinel.theme);
		assert.ok(component.render(20).join("\n").includes("Caveman"), "header present at width 20");
		assert.ok(
			component.render(120).join("\n").includes("Caveman"),
			"header present at width 120",
		);
	});

	it("renders under the real system theme in both appearances (AC 3)", async () => {
		for (const helper of ["style", "fg"] as const) {
			assert.equal(
				typeof activeThemeSingleton()[helper],
				"function",
				`Theme.${helper} must exist on the real singleton`,
			);
		}
		const previous = process.env.COLORFGBG;
		try {
			for (const [fgbg, appearance] of [
				["15;0", "dark"],
				["0;15", "light"],
			] as const) {
				process.env.COLORFGBG = fgbg;
				initTheme("system");
				const real = activeThemeSingleton();
				assert.equal(
					real.appearance,
					appearance,
					`COLORFGBG=${fgbg} should resolve ${appearance}`,
				);
				const component = await renderConfigDialog(real);
				const lines = component.render(80);
				assert.ok(
					String(lines[0]).includes("Caveman Config"),
					`${appearance} system-theme header: ${lines[0]}`,
				);
				assert.ok(
					String(real.style(" Caveman Config", { fg: "accent", bold: true })).includes(
						"Caveman Config",
					),
				);
			}
		} finally {
			if (previous === undefined) delete process.env.COLORFGBG;
			else process.env.COLORFGBG = previous;
		}
	});

	it("makeSentinelTheme mirrors the real Theme surface — no fictional API", () => {
		const sentinel = makeSentinelTheme();
		const real = activeThemeSingleton();
		for (const [key, value] of Object.entries(sentinel.theme)) {
			if (key === "name" || key === "sourcePath") continue;
			assert.equal(
				typeof real[key],
				typeof value,
				`sentinel exposes ${key} (${typeof value}) but the real Theme does not match`,
			);
		}
	});

	it("a theme lacking style throws TypeError — documents the reported mechanism", async () => {
		const themeWithoutStyle = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		await assert.rejects(
			() => renderConfigDialog(themeWithoutStyle),
			TypeError,
			"a theme without style must fail loudly, proving the injected real theme does not",
		);
	});

	it("caveman production sources contain no nested theme calls (AC 2)", () => {
		const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
			const source = readFileSync(join(dir, file), "utf8");
			assert.ok(
				!/theme\.\w+\([^)]*theme\.\w+\(/.test(source),
				`${file} contains a nested theme call`,
			);
		}
	});
});
