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

describe("footer — trust status display", () => {
	it('render output includes 🔒 lock icon when trustStatus="trusted"', () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.trustStatus = "trusted";

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
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
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config, footerConfig as any);
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		assert.ok(allRows.includes("🔒"), "render output should include lock emoji when trusted");
	});

	it('render output includes 🔓 unlock icon when trustStatus="untrusted"', () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.trustStatus = "untrusted";

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
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
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config, footerConfig as any);
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		assert.ok(allRows.includes("🔓"), "render output should include unlock emoji when untrusted");
	});

	it("render output includes ❓ when trustStatus is undefined", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
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
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config, footerConfig as any);
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		assert.ok(
			allRows.includes("❓"),
			"render output should include question mark when trustStatus undefined",
		);
	});
});
describe("footer — usage color tokens", () => {
	it('low tokens emit theme.fg("success", "64.0K/128.0K")', () => {
		const { component, captured } = createHarness({
			usage: { tokens: 64_000, contextWindow: 128_000 },
		});
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "success" && c.text === "64.0K/128.0K"),
			`expected success token segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("mid tokens emit warning", () => {
		const { component, captured } = createHarness({
			usage: { tokens: 120_000, contextWindow: 128_000 },
		});
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "warning" && c.text === "120.0K/128.0K"),
			`expected warning token segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("overflow/null-tier tokens emit error", () => {
		const { component, captured } = createHarness({
			usage: { tokens: 200_000, contextWindow: 128_000 },
		});
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "error" && c.text === "200.0K/128.0K"),
			`expected error token segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("rendered rows contain no truecolor SGR escape", () => {
		const { component } = createHarness();
		const all = component.render(120).join("");
		assert.ok(!all.includes("\x1b[38;2;"), "no truecolor SGR should be emitted");
	});

	it("renders against a theme exposing only fg (0.79.10 compat)", () => {
		const { component } = createHarness();
		const rows = component.render(80);
		assert.ok(rows.length >= 1, "render should succeed without style/colors/appearance");
	});

	it("percentage bracket: ≥90 → error, 70–89 → warning, <70 → dim", () => {
		const high = createHarness({ usage: { tokens: 120_000, contextWindow: 128_000 } });
		high.component.render(120);
		assert.ok(high.captured.some((c) => c.color === "error" && c.text === "[94%]"));

		const mid = createHarness({ usage: { tokens: 90_000, contextWindow: 128_000 } });
		mid.component.render(120);
		assert.ok(mid.captured.some((c) => c.color === "warning" && c.text === "[70%]"));

		const low = createHarness({ usage: { tokens: 64_000, contextWindow: 128_000 } });
		low.component.render(120);
		assert.ok(low.captured.some((c) => c.color === "dim" && c.text === "[50%]"));
	});

	it("tokens=null with a known max emits dim '◉ .../<max>'", () => {
		const fc = createDefaultFooterConfig();
		fc.lastContextWindow.value = 128_000;
		const { component, captured } = createHarness({ usage: null, footerConfig: fc });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "◉ .../128.0K"),
			`expected dim ellipsis segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("no usage and no max emits dim '◉ .../?'", () => {
		const { component, captured } = createHarness({ usage: null });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "◉ .../?"),
			`expected dim '◉ .../?', got: ${JSON.stringify(captured)}`,
		);
	});
});
describe("footer — fullscreen width matrix", () => {
	it("renders ≥1 row fitting 40/80/120 cols without throwing", () => {
		const { component } = createHarness();
		for (const width of [40, 80, 120]) {
			const rows = component.render(width);
			assert.ok(rows.length >= 1, `width ${width}: at least one row`);
			for (const row of rows) {
				assert.ok(
					visibleWidth(row) <= width,
					`width ${width}: row exceeds width: ${JSON.stringify(row)}`,
				);
			}
		}
	});

	it("resize 120 → 40 → 120: each render obeys its own width", () => {
		const { component } = createHarness();
		for (const width of [120, 40, 120]) {
			for (const row of component.render(width)) {
				assert.ok(
					visibleWidth(row) <= width,
					`resized to ${width}: row exceeds width: ${JSON.stringify(row)}`,
				);
			}
		}
	});

	it("40 cols with UI + CodeFlow links: every OSC 8 link is closed (never mid-link cut)", () => {
		const fc = createDefaultFooterConfig();
		fc.uiUrl = "http://127.0.0.1:9600";
		fc.codeflowUrl = "http://localhost:9100/?repo=local/workspace&run=1";
		const { component } = createHarness({ footerConfig: fc });
		const rows = component.render(40);
		const row3 = rows[rows.length - 1]!;
		const openers = (row3.match(/\x1b\]8;;http/g) ?? []).length;
		const closers = (row3.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
		assert.strictEqual(openers, closers, "every OSC 8 opener must have a matching closer");
		assert.ok(visibleWidth(row3) <= 40, "link row must fit width");
	});

	it("install calls tui.setClearOnShrink(true)", () => {
		let called = false;
		createHarness({
			setClearOnShrinkSpy: () => {
				called = true;
			},
		});
		assert.ok(called, "setClearOnShrink should be called on install");
	});
});
describe("footer — appearance-adaptive secondary text", () => {
	const withWorktree = (name: string) => {
		const fc = createDefaultFooterConfig();
		fc.worktreeName = name;
		return fc;
	};

	it("light: worktree label is muted", () => {
		const { component, captured } = createHarness({
			appearance: "light",
			footerConfig: withWorktree("my-feature"),
		});
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "muted" && c.text === "[my-feature]"),
			`expected muted worktree label, got: ${JSON.stringify(captured)}`,
		);
	});

	it("light: Session: label is muted", () => {
		const fc = createDefaultFooterConfig();
		fc.sessionName = "sess";
		const { component, captured } = createHarness({ appearance: "light", footerConfig: fc });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "muted" && c.text === "Session:"),
			`expected muted Session: label, got: ${JSON.stringify(captured)}`,
		);
	});

	it("light: separators/joiners/decorations stay dim", () => {
		const { component, captured } = createHarness({
			appearance: "light",
			footerConfig: withWorktree("my-feature"),
		});
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "│"),
			`expected dim separator, got: ${JSON.stringify(captured)}`,
		);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "·"),
			`expected dim joiner, got: ${JSON.stringify(captured)}`,
		);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "🧠 "),
			`expected dim brain decoration, got: ${JSON.stringify(captured)}`,
		);
	});

	it("dark: secondary text stays dim (default visuals preserved)", () => {
		const fc = withWorktree("my-feature");
		fc.sessionName = "sess";
		const { component, captured } = createHarness({ appearance: "dark", footerConfig: fc });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "[my-feature]"),
			`expected dim worktree label, got: ${JSON.stringify(captured)}`,
		);
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "Session:"),
			`expected dim Session: label, got: ${JSON.stringify(captured)}`,
		);
	});

	it("no appearance property: dim fallback, render succeeds (0.79.10 compat)", () => {
		const { component, captured } = createHarness({ footerConfig: withWorktree("my-feature") });
		const rows = component.render(120);
		assert.ok(rows.length >= 1, "render should succeed without appearance");
		assert.ok(
			captured.some((c) => c.color === "dim" && c.text === "[my-feature]"),
			`expected dim fallback, got: ${JSON.stringify(captured)}`,
		);
	});

	it("resolved once at install: mutating theme.appearance after install has no effect", () => {
		const fc = createDefaultFooterConfig();
		fc.sessionName = "sess";
		const { component, captured, theme } = createHarness({ appearance: "light", footerConfig: fc });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "muted" && c.text === "Session:"),
			"first render should use muted (light)",
		);

		captured.length = 0;
		theme.appearance = "dark";
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "muted" && c.text === "Session:"),
			`token must be resolved in the install closure, got: ${JSON.stringify(captured)}`,
		);
	});

	it("light render emits no truecolor SGR and works against an fg-only theme", () => {
		const { component } = createHarness({ appearance: "light" });
		const all = component.render(120).join("");
		assert.ok(!all.includes("\x1b[38;2;"), "no truecolor SGR should be emitted");
	});
});
