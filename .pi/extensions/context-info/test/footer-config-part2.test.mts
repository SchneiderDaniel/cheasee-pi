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

describe("installFooter with FooterConfig", () => {
	it("calls setFooter with a function when config is enabled and mode is tui", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [],
			showTimer: true,
			showTps: true,
			showCache: true,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();

		let setFooterArg: unknown = undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx as any, config, footerConfig as any);

		assert.ok(typeof setFooterArg === "function", "setFooter should receive a function");
	});

	it("calls setFooter with undefined when config is disabled", () => {
		const config: ContextStatusBarConfig = {
			enabled: false,
			thresholds: [],
			showTimer: true,
			showTps: true,
			showCache: true,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();

		let setFooterArg: unknown = undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx as any, config, footerConfig as any);

		assert.strictEqual(setFooterArg, undefined, "setFooter should receive undefined when disabled");
	});

	it("calls setFooter with undefined when config is null", () => {
		const footerConfig = createDefaultFooterConfig();

		let setFooterArg: unknown = undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx as any, null, footerConfig as any);

		assert.strictEqual(
			setFooterArg,
			undefined,
			"setFooter should receive undefined when config is null",
		);
	});

	it("render function accesses footerConfig fields through value wrappers", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig: FooterConfig = {
			worktreeName: "test-worktree",
			thinkingLevel: "high",
			tpsSamples: [
				{ time: Date.now() - 5000, cumulativeTokens: 0 },
				{ time: Date.now(), cumulativeTokens: 200 },
			],
			lastComputedTps: { value: 40.0 },
			lastContextWindow: { value: 128000 },
			toolCallCount: { value: 3 },
			cacheRead: 5000,
			cacheWrite: 1000,
			cacheHitRate: 83,
			sessionName: "test-session",
			trustStatus: "trusted",
			sessionId: "",
			uiUrl: null,
			codeflowUrl: null,
			issueNumber: { value: undefined },
			issueRepo: { value: undefined },
			issueTitle: { value: undefined },
			prevCpuUsage: 0,
			prevCpuTime: 0,
			allocatedCpus: 4,
			containerDisplay: { value: "" },
		};

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						// Simulate setup call that returns the component
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
			getContextUsage: () => ({ tokens: 64000, contextWindow: 128000 }),
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config, footerConfig as any);

		assert.ok(footerComponent, "footer component should be created");
		assert.ok(typeof footerComponent!.render === "function", "footer should have render method");

		// Render at 80 width — should not throw
		const result = footerComponent!.render(80);
		assert.ok(Array.isArray(result), "render should return string array");
		assert.ok(result.length > 0, "render should return at least one row");
	});

	it("value-wrapped fields (toolCallCount, lastContextWindow) mutations reflect in render", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: 100000 }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		footerConfig.thinkingLevel = "low";

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

		// Mutate value-wrapped fields after install — mutations should be visible
		footerConfig.toolCallCount.value = 7;
		footerConfig.lastContextWindow.value = 256000;
		footerConfig.lastComputedTps.value = 50.5;

		// Render should not throw and should reflect new state
		const result = footerComponent!.render(80);
		assert.ok(Array.isArray(result));
		assert.ok(result[0]!.includes("7"), "render output should include tool call count of 7");

		// thinkingLevel is read live from footerConfig at render time (reasoning
		// segment), so after-install mutations would reflect; worktreeName is
		// still captured at install time and updated by re-installing the footer.
	});

	it("render shows '· ○ off' reasoning fallback when thinkingLevel is unset", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = createDefaultFooterConfig();
		assert.strictEqual(footerConfig.thinkingLevel, "", "precondition: level starts unset");

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{ fg: (_color: string, text: string) => text },
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

		const row0 = footerComponent!.render(80)[0]!;
		assert.ok(row0.includes("· ○ off"), `should contain '· ○ off', got: ${row0}`);
	});
});
