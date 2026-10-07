/**
 * Tests for FooterConfig consolidation — verifying the new interface
 * and installFooter signature work correctly.
 *
 * These test the interface shape and behavior. The FooterConfig interface is
 * imported from the canonical types.ts (compile-time enforced); the
 * installFooter function is imported from the real footer.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/footer-config.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCacheHitRate } from "../formatting.ts";
import { installFooter } from "../footer.ts";
import { createDefaultFooterConfig } from "../footer-state.ts";
import type { FooterConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Inline helper interfaces — TpsSample/ThresholdEntry/ContextStatusBarConfig
// are structurally identical to types.ts (kept local per test plan).
// FooterConfig is NOT duplicated here — imported from types.ts instead.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// formatCacheHitRate tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// installFooter with mode guard (Improvement #3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// installFooter with FooterConfig
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CH display tests (Improvement #1)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session name display tests (Improvement #2)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trust status display tests (Improvement #4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Usage color tokens (Phase 2) + fullscreen width matrix (Phase 3)
// ---------------------------------------------------------------------------

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

/** Install the footer against a capture-style theme exposing only `fg`.
 *  Deliberately omits `style`/`colors` — their absence proves the footer renders
 *  against a 0.79.10-shaped theme. `appearance` is optional and set only when the
 *  test asks for it. */
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

describe("footer — usage color tokens", () => {
	it("low tokens emit theme.fg(\"success\", \"64.0K/128.0K\")", () => {
		const { component, captured } = createHarness({ usage: { tokens: 64_000, contextWindow: 128_000 } });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "success" && c.text === "64.0K/128.0K"),
			`expected success token segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("mid tokens emit warning", () => {
		const { component, captured } = createHarness({ usage: { tokens: 120_000, contextWindow: 128_000 } });
		component.render(120);
		assert.ok(
			captured.some((c) => c.color === "warning" && c.text === "120.0K/128.0K"),
			`expected warning token segment, got: ${JSON.stringify(captured)}`,
		);
	});

	it("overflow/null-tier tokens emit error", () => {
		const { component, captured } = createHarness({ usage: { tokens: 200_000, contextWindow: 128_000 } });
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

// ---------------------------------------------------------------------------
// Appearance-adaptive secondary text (Phase 2)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Width + fullscreen regression under light appearance (Phase 3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Docs mention appearance-aware secondary text (Phase 5)
// ---------------------------------------------------------------------------

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const readSource = (rel: string) => readFileSync(joinPath(TEST_DIR, rel), "utf-8");

describe("context-info docs — appearance-awareness", () => {
	it("README and docs/extensions describe appearance-aware secondary text", () => {
		for (const rel of ["../README.md", "../../../../docs/extensions/context-info.md"]) {
			const src = readSource(rel);
			assert.ok(/appearance/i.test(src), `${rel} should mention appearance`);
		}
	});
});

// ---------------------------------------------------------------------------
// Behavior guard (Phase 4): rendered output carries no fixed-hex literals
// ---------------------------------------------------------------------------

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
