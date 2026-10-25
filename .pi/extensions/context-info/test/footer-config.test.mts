import assert from "node:assert";

import { readFileSync } from "node:fs";

import { dirname, join as joinPath } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { formatCacheHitRate } from "../formatting.ts";

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

describe("FooterConfig", () => {
	it("can be created with default values matching the interface", () => {
		const config = createDefaultFooterConfig();

		assert.strictEqual(config.worktreeName, null);
		assert.strictEqual(config.thinkingLevel, "");
		assert.deepStrictEqual(config.tpsSamples, []);
		assert.strictEqual(config.lastComputedTps.value, null);
		assert.strictEqual(config.lastContextWindow.value, undefined);
		assert.strictEqual(config.toolCallCount.value, 0);
		assert.strictEqual(config.cacheRead, undefined);
		assert.strictEqual(config.cacheWrite, undefined);
		assert.strictEqual(config.cacheHitRate, undefined);
		assert.strictEqual(config.sessionName, undefined);
		assert.strictEqual(config.trustStatus, undefined);
		assert.strictEqual(config.issueNumber.value, undefined);
		assert.strictEqual(config.issueRepo.value, undefined);
		assert.strictEqual(config.issueTitle.value, undefined);
		assert.strictEqual(config.uiUrl, null);
		assert.strictEqual(config.codeflowUrl, null);
	});

	it("value wrappers allow mutation through shared reference", () => {
		const config = createDefaultFooterConfig();

		// Simulate passing footerConfig by reference and mutating
		const ref = config;
		ref.toolCallCount.value = 5;
		ref.lastComputedTps.value = 42.5;
		ref.lastContextWindow.value = 128000;
		ref.worktreeName = "my-feature";
		ref.thinkingLevel = "high";
		ref.cacheRead = 76288;
		ref.cacheWrite = 0;
		ref.cacheHitRate = 99;
		ref.sessionName = "my-session";
		ref.trustStatus = "trusted";

		// Original reflects all mutations
		assert.strictEqual(config.worktreeName, "my-feature");
		assert.strictEqual(config.thinkingLevel, "high");
		assert.strictEqual(config.lastComputedTps.value, 42.5);
		assert.strictEqual(config.lastContextWindow.value, 128000);
		assert.strictEqual(config.toolCallCount.value, 5);
		assert.strictEqual(config.cacheRead, 76288);
		assert.strictEqual(config.cacheWrite, 0);
		assert.strictEqual(config.cacheHitRate, 99);
		assert.strictEqual(config.sessionName, "my-session");
		assert.strictEqual(config.trustStatus, "trusted");
	});

	it("tpsSamples array mutations are visible through reference", () => {
		const config = createDefaultFooterConfig();

		const ref = config;
		ref.tpsSamples.push({ time: 1000, cumulativeTokens: 50 });
		ref.tpsSamples.push({ time: 2000, cumulativeTokens: 150 });

		assert.strictEqual(config.tpsSamples.length, 2);
		assert.strictEqual(config.tpsSamples[0]!.cumulativeTokens, 50);
	});

	it("supports typed access with all fields populated", () => {
		const config: FooterConfig = {
			worktreeName: "main",
			thinkingLevel: "medium",
			tpsSamples: [{ time: Date.now(), cumulativeTokens: 100 }],
			lastComputedTps: { value: 15.3 },
			lastContextWindow: { value: 128000 },
			toolCallCount: { value: 3 },
			cacheRead: 50000,
			cacheWrite: 20000,
			cacheHitRate: 71,
			sessionName: "my-session",
			trustStatus: "trusted",
			sessionId: "",
			uiUrl: "http://127.0.0.1:9600",
			codeflowUrl: "http://localhost:9100/?repo=local/workspace&run=1",
			issueNumber: { value: 862 },
			issueRepo: { value: "owner/repo" },
			issueTitle: { value: "Refactor footer" },
			prevCpuUsage: 0,
			prevCpuTime: 0,
			allocatedCpus: 4,
			containerDisplay: { value: "" },
		};

		assert.strictEqual(config.worktreeName, "main");
		assert.strictEqual(config.thinkingLevel, "medium");
		assert.strictEqual(config.tpsSamples.length, 1);
		assert.strictEqual(config.lastComputedTps.value, 15.3);
		assert.strictEqual(config.cacheHitRate, 71);
		assert.strictEqual(config.sessionName, "my-session");
		assert.strictEqual(config.trustStatus, "trusted");
		assert.strictEqual(config.issueNumber.value, 862);
		assert.strictEqual(config.issueRepo.value, "owner/repo");
		assert.strictEqual(config.issueTitle.value, "Refactor footer");
	});
});
describe("formatCacheHitRate", () => {
	it("formatCacheHitRate(75) → CH: 75%", () => {
		assert.strictEqual(formatCacheHitRate(75), "CH: 75%");
	});

	it("formatCacheHitRate(0) → CH: 0%", () => {
		assert.strictEqual(formatCacheHitRate(0), "CH: 0%");
	});

	it("formatCacheHitRate(100) → CH: 100%", () => {
		assert.strictEqual(formatCacheHitRate(100), "CH: 100%");
	});

	it("formatCacheHitRate(33.333) → CH: 33% (rounded integer)", () => {
		assert.strictEqual(formatCacheHitRate(33.333), "CH: 33%");
	});

	it("formatCacheHitRate(undefined) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(undefined), "");
	});

	it("formatCacheHitRate(null) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(null as any), "");
	});

	it("formatCacheHitRate(NaN) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(NaN), "");
	});
});
describe("installFooter — mode guard", () => {
	const modeScenarios = [
		{ mode: "rpc" },
		{ mode: "json" },
		{ mode: "print" },
		{ mode: "headless" },
	];

	for (const { mode } of modeScenarios) {
		it(`ctx.mode === "${mode}" → setFooter(undefined), no render function registered`, () => {
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
				mode,
				ui: {
					setFooter: (fn: unknown) => {
						setFooterArg = fn;
					},
					setStatus: () => {},
				},
				getContextUsage: () => undefined,
			};

			installFooter(ctx as any, config, footerConfig as any);

			assert.strictEqual(
				setFooterArg,
				undefined,
				"setFooter should receive undefined for non-TUI mode",
			);
		});
	}

	it(`ctx.mode === "tui" → setFooter receives a function (render registered)`, () => {
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

		assert.ok(
			typeof setFooterArg === "function",
			"setFooter should receive a function for TUI mode",
		);
	});

	it("ctx.mode undefined (backward compat) → setFooter receives a function", () => {
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
			// mode undefined — old pi version compatibility
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx as any, config, footerConfig as any);

		assert.ok(
			typeof setFooterArg === "function",
			"setFooter should receive a function when mode is undefined",
		);
	});
});
