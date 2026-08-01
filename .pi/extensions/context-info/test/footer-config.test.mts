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
import { describe, it } from "node:test";
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

		// Fields destructured at call time (worktreeName, thinkingLevel) are not expected
		// to reflect after-install mutations — they're updated by re-installing footer
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
