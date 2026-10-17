import assert from "node:assert";

import { readFileSync } from "node:fs";

import { dirname, join as joinPath } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

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

describe("footer — CH display", () => {
	it("render output includes CH string when showCache=true and cacheHitRate is a number", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: true,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 76288;
		footerConfig.cacheWrite = 1024;
		footerConfig.cacheHitRate = 99;

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
		assert.ok(allRows.includes("CH: 99%"), `render output should include CH: 99%, got: ${allRows}`);
	});

	it("render output omits CH when showCache=false", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 76288;
		footerConfig.cacheWrite = 1024;
		footerConfig.cacheHitRate = 99;

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
		assert.ok(!allRows.includes("CH:"), "render output should not include CH when showCache=false");
	});

	it("render output omits CH when cacheHitRate is undefined", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: true,
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
			!allRows.includes("CH:"),
			"render output should not include CH when cacheHitRate is undefined",
		);
	});
});
describe("footer — session name display", () => {
	it('render row3 shows "Session: <name>" when sessionName set', () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.sessionName = "my-session";

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
		// Need to set sessionId for render to have content in addition to sessionName
		footerConfig.sessionId = "abc-123";
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		assert.ok(
			allRows.includes("Session:") && allRows.includes("my-session"),
			"render output should include session name",
		);
	});

	it('render row3 shows "SessionID: <id>" fallback when sessionName is undefined', () => {
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
		footerConfig.sessionId = "abc-123";
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		assert.ok(
			allRows.includes("SessionID:") && allRows.includes("abc-123"),
			"render output should include session ID fallback",
		);
	});

	it("row3 shows trust indicator when both sessionName and sessionId are empty/falsy", () => {
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
		footerConfig.sessionId = "";
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");
		// Row3 always shows trust indicator (❓ when undefined)
		assert.ok(allRows.includes("❓"), "should show trust indicator even without session info");
	});
});
