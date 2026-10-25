/**
 * Phase 2/3: openConfigDialog header rendering (VBA god module split #2036).
 *
 * The theme-sentinel helpers, the dialog harness and the header-styling suite
 * moved out of config-ui.test.ts so neither module exceeds the function ceiling.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSentinelTheme } from "./config-ui-test-theme.ts";

/** The real Theme singleton installed by initTheme() (not re-exported from the index). */
function activeThemeSingleton(): any {
	const theme = (globalThis as Record<symbol, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	assert.ok(theme, "initTheme() must run before reading the theme singleton");
	return theme;
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
		assert.ok(component.render(120).join("\n").includes("Caveman"), "header present at width 120");
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
				assert.equal(real.appearance, appearance, `COLORFGBG=${fgbg} should resolve ${appearance}`);
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
