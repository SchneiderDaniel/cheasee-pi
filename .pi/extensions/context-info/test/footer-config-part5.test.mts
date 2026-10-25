import assert from "node:assert";

import { readFileSync } from "node:fs";

import { dirname, join as joinPath } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { installFooter } from "../footer.ts";

import { createDefaultFooterConfig } from "../footer-state.ts";

import type { FooterConfig } from "../types.ts";

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ThresholdEntry {
	maxTokens: number | null;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
	welcomeTimeoutMs: number;
}

interface CapturedFgCall {
	color: string;
	text: string;
}

interface FooterHarnessOptions {
	/** Context usage; `null` ⇒ getContextUsage() returns undefined. */
	usage?: { tokens: number; contextWindow: number } | null;
	thresholds?: ThresholdEntry[];
	footerConfig?: FooterConfig;
	setClearOnShrinkSpy?: () => void;
	/** Reported terminal appearance; omitted ⇒ theme has no `appearance` (0.79.10 shape). */
	appearance?: "dark" | "light";
}

function createHarness(options: FooterHarnessOptions = {}) {
	const captured: CapturedFgCall[] = [];
	const theme: { fg: (color: string, text: string) => string; appearance?: "dark" | "light" } = {
		fg: (color: string, text: string) => {
			captured.push({ color, text });
			return text;
		},
	};
	if (options.appearance) theme.appearance = options.appearance;
	const config: ContextStatusBarConfig = {
		enabled: true,
		thresholds: options.thresholds ?? [
			{ maxTokens: 100_000 },
			{ maxTokens: 150_000 },
			{ maxTokens: null },
		],
		showTimer: false,
		showTps: false,
		showCache: false,
		welcomeTimeoutMs: 0,
	};
	const footerConfig = options.footerConfig ?? createDefaultFooterConfig();
	const usage =
		options.usage === undefined ? { tokens: 64_000, contextWindow: 128_000 } : options.usage;

	let component: { render: (w: number) => string[]; dispose: () => void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			setFooter: (fn: unknown) => {
				if (typeof fn === "function") {
					component = (fn as any)(
						{
							requestRender: () => {},
							setClearOnShrink: options.setClearOnShrinkSpy ?? (() => {}),
						},
						theme,
						{
							onBranchChange: () => () => {},
							getGitBranch: () => "main",
							getExtensionStatuses: () => new Map(),
						},
					);
				}
			},
			setStatus: () => {},
		},
		getContextUsage: () => (usage === null ? undefined : usage),
		model: { id: "test-model" },
	};

	installFooter(ctx as any, config, footerConfig as any);
	assert.ok(component, "footer component should be registered");
	return { component: component!, captured, footerConfig, config, theme };
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const readSource = (rel: string) => readFileSync(joinPath(TEST_DIR, rel), "utf-8");

describe("footer — width regression under light appearance", () => {
	for (const width of [40, 80, 120]) {
		it(`light appearance renders ≥1 row fitting ${width} cols without throwing`, () => {
			const { component } = createHarness({
				appearance: "light",
				footerConfig: createDefaultFooterConfig(),
			});
			const rows = component.render(width);
			assert.ok(rows.length >= 1, `width ${width}: at least one row`);
			for (const row of rows) {
				assert.ok(
					visibleWidth(row) <= width,
					`width ${width}: row exceeds width: ${JSON.stringify(row)}`,
				);
			}
		});
	}

	it("light appearance resize 120 → 40 → 120 obeys each width", () => {
		const { component } = createHarness({ appearance: "light" });
		for (const width of [120, 40, 120]) {
			for (const row of component.render(width)) {
				assert.ok(
					visibleWidth(row) <= width,
					`resized to ${width}: row exceeds width: ${JSON.stringify(row)}`,
				);
			}
		}
	});

	it("light appearance, 40 cols with UI + CodeFlow links: OSC 8 stays balanced", () => {
		const fc = createDefaultFooterConfig();
		fc.uiUrl = "http://127.0.0.1:9600";
		fc.codeflowUrl = "http://localhost:9100/?repo=local/workspace&run=1";
		const { component } = createHarness({ appearance: "light", footerConfig: fc });
		const rows = component.render(40);
		const row3 = rows[rows.length - 1]!;
		const openers = (row3.match(/\x1b\]8;;http/g) ?? []).length;
		const closers = (row3.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
		assert.strictEqual(openers, closers, "every OSC 8 opener must have a matching closer");
		assert.ok(visibleWidth(row3) <= 40, "link row must fit width");
	});
});
describe("context-info docs — appearance-awareness", () => {
	it("README and docs/extensions describe appearance-aware secondary text", () => {
		for (const rel of ["../README.md", "../../../../docs/extensions/context-info.md"]) {
			const src = readSource(rel);
			assert.ok(/appearance/i.test(src), `${rel} should mention appearance`);
		}
	});
});
describe("footer — rendered output carries no fixed-hex color literals", () => {
	it("rendered rows contain no 6-digit hex color in any appearance", () => {
		for (const appearance of ["dark", "light"] as const) {
			const { component } = createHarness({ appearance });
			for (const row of component.render(120)) {
				assert.ok(
					!/#[0-9a-fA-F]{6}/.test(row),
					`${appearance} row must not contain a 6-digit hex literal: ${JSON.stringify(row)}`,
				);
			}
		}
	});
});
