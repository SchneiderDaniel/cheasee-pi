/**
 * Regression tests for issue #2136 — cache hit rate must be honest, and the
 * two-letter abbreviation must be replaced by an explicit label.
 *
 * Reported problem: `📦 11.4K/1.2K │` followed by a two-letter abbreviation and
 * `91%`. The abbreviation explained nothing, and the
 * formula behind it — `cacheRead / (cacheRead + cacheWrite)` — reports 100%
 * whenever a provider returns positive `cacheRead` with zero `cacheWrite`,
 * which says nothing about cache-eligible prompt tokens that were neither read
 * nor written. The metric is now
 * `cacheRead / (input + cacheRead + cacheWrite)` and is labelled
 * `Cache Hit Rate`, rendered as `--` when the denominator is zero.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/cache-label-regression.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FooterState, createDefaultFooterConfig } from "../footer-state.ts";
import { applyCacheStats } from "../events-data.ts";
import { registerFooterEvents } from "../events.ts";
import { installFooter } from "../footer.ts";
import {
	formatCacheHitRate,
	formatCacheStats,
	formatEstimatedTps,
	formatTps,
} from "../formatting.ts";
import type { ContextStatusBarConfig, FooterConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createMockCtx(): any {
	return {
		ui: {
			setFooter: mock.fn(),
			setStatus: mock.fn(),
			setWidget: mock.fn(),
			setWorkingIndicator: mock.fn(),
			notify: mock.fn(),
			theme: { fg: (_color: string, text: string) => text },
		},
		model: { id: "test-model", contextWindow: 128000 },
		getContextUsage: () => ({ tokens: 5000, contextWindow: 128000 }),
		sessionManager: { getSessionFile: "/tmp/test_12345.jsonl" },
		cwd: "/tmp",
	};
}

function makeState(): FooterState {
	return new FooterState(createMockCtx());
}

const ISSUE_USAGE = { input: 1000, cacheRead: 11400, cacheWrite: 1200 };

function createCapturingPi(): {
	pi: ExtensionAPI;
	emit: (event: string, payload: unknown) => void;
} {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		events: { on: () => () => {} },
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		getSessionName: () => "test-session",
	} as unknown as ExtensionAPI;
	return {
		pi,
		emit: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload, {});
		},
	};
}

/** Render the footer into plain text rows with `showTps`/`showCache` as given. */
function renderRows(
	footerConfig: FooterConfig,
	showCache: boolean,
	showTps: boolean,
	width = 120,
): string {
	const config: ContextStatusBarConfig = {
		enabled: true,
		thresholds: [{ maxTokens: null }],
		showTimer: false,
		showTps,
		showCache,
		welcomeTimeoutMs: 0,
	};
	let component: { render: (w: number) => string[]; dispose: () => void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			setFooter: (fn: unknown) => {
				if (typeof fn === "function") {
					component = (fn as any)(
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
	assert.doesNotThrow(() => installFooter(ctx as any, config, footerConfig as any));
	assert.ok(component, "footer component should be registered");
	return component!.render(width).join(" ");
}

// ---------------------------------------------------------------------------
// applyCacheStats — atomic counts + rate from one usage record
// ---------------------------------------------------------------------------

describe("applyCacheStats — new hit-rate definition", () => {
	it("sets cacheRead, cacheWrite and cacheHitRate together", () => {
		const state = makeState();
		applyCacheStats(state, ISSUE_USAGE);
		assert.strictEqual(state.footerConfig.cacheRead, 11400);
		assert.strictEqual(state.footerConfig.cacheWrite, 1200);
		const rate = state.footerConfig.cacheHitRate;
		assert.ok(rate !== undefined, "rate must be set with the counts");
		assert.ok(Math.abs(rate! - 83.82) < 0.01, `expected ~83.82, got ${rate}`);
	});

	it("zero cacheWrite with positive input stays below 100", () => {
		const state = makeState();
		applyCacheStats(state, { input: 1000, cacheRead: 5000, cacheWrite: 0 });
		assert.strictEqual(state.footerConfig.cacheWrite, 0);
		const rate = state.footerConfig.cacheHitRate;
		assert.ok(rate !== undefined);
		assert.ok(rate! < 100, `zero cacheWrite must not report 100%, got ${rate}`);
	});

	it("all-zero usage leaves the rate unavailable (no 0, no 100)", () => {
		const state = makeState();
		applyCacheStats(state, { input: 0, cacheRead: 0, cacheWrite: 0 });
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
	});

	it("is atomic: a usage record without input mutates no field at all", () => {
		const state = makeState();
		applyCacheStats(state, { cacheRead: 5000, cacheWrite: 0 });
		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
	});

	it("does not overwrite good state with an unusable record", () => {
		const state = makeState();
		applyCacheStats(state, ISSUE_USAGE);
		const good = state.footerConfig.cacheHitRate;
		applyCacheStats(state, {});
		assert.strictEqual(state.footerConfig.cacheHitRate, good);
		assert.strictEqual(state.footerConfig.cacheRead, 11400);
	});

	it("is driven by message_end in the registered handlers", () => {
		const state = makeState();
		const { pi, emit } = createCapturingPi();
		registerFooterEvents(pi, () => state);

		emit("message_end", {
			type: "message_end",
			message: { role: "assistant", content: [], usage: ISSUE_USAGE },
		});

		assert.strictEqual(state.footerConfig.cacheRead, 11400);
		assert.strictEqual(state.footerConfig.cacheWrite, 1200);
		assert.ok(Math.abs(state.footerConfig.cacheHitRate! - 83.82) < 0.01);
	});
});

// ---------------------------------------------------------------------------
// model_select — clears counts as well as the rate
// ---------------------------------------------------------------------------

describe("registerFooterEvents — model_select", () => {
	it("clears cacheRead, cacheWrite and cacheHitRate, keeps the context window", () => {
		const state = makeState();
		applyCacheStats(state, ISSUE_USAGE);
		const { pi, emit } = createCapturingPi();
		registerFooterEvents(pi, () => state);

		emit("model_select", { model: { id: "other-model", contextWindow: 256000 } });

		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
		assert.strictEqual(state.footerConfig.lastContextWindow.value, 256000);
	});
});

// ---------------------------------------------------------------------------
// Display strings
// ---------------------------------------------------------------------------

describe("formatCacheHitRate — explicit label", () => {
	it('renders "Cache Hit Rate: <n>%"', () => {
		assert.strictEqual(formatCacheHitRate(91), "Cache Hit Rate: 91%");
		assert.strictEqual(formatCacheHitRate(0), "Cache Hit Rate: 0%");
		assert.strictEqual(formatCacheHitRate(100), "Cache Hit Rate: 100%");
		assert.strictEqual(formatCacheHitRate(33.333), "Cache Hit Rate: 33%");
	});

	it("keeps the label visible when the rate is unavailable", () => {
		assert.strictEqual(formatCacheHitRate(undefined), "Cache Hit Rate: --");
		assert.strictEqual(formatCacheHitRate(null as unknown as undefined), "Cache Hit Rate: --");
		assert.strictEqual(formatCacheHitRate(Number.NaN), "Cache Hit Rate: --");
	});

	it("never uses the opaque CH abbreviation", () => {
		const samples: Array<number | undefined> = [0, 33.333, 91, 100, undefined, Number.NaN];
		for (const rate of samples) {
			assert.ok(!formatCacheHitRate(rate).includes("CH:"), `unexpected CH for ${String(rate)}`);
		}
	});

	it("formatCacheStats is unchanged", () => {
		assert.strictEqual(formatCacheStats(11400, 1200), "\u{1F4E6} 11.4K/1.2K");
	});
});

describe("formatEstimatedTps — marks the estimate", () => {
	it('renders "-- t/s" when unavailable', () => {
		assert.strictEqual(formatEstimatedTps(null), "-- t/s");
	});

	it("prefixes the value with ~ and delegates to formatTps", () => {
		assert.strictEqual(formatEstimatedTps(42.53), "~42.5 t/s");
		assert.strictEqual(formatEstimatedTps(0), "~0.0 t/s");
		assert.strictEqual(formatEstimatedTps(999.9), "~999.9 t/s");
		assert.strictEqual(formatEstimatedTps(1234.5), "~1235 t/s");
	});

	it("formatTps itself stays unmarked (the ~ is the estimate marker)", () => {
		assert.strictEqual(formatTps(42.53), "42.5 t/s");
	});
});

// ---------------------------------------------------------------------------
// Footer row 2 — formatting only, no rate math
// ---------------------------------------------------------------------------

describe("footer row 2 — cache segment", () => {
	it('shows "Cache Hit Rate: 84%" and no CH abbreviation', () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 11400;
		footerConfig.cacheWrite = 1200;
		footerConfig.cacheHitRate = 84;

		const rows = renderRows(footerConfig, true, false);

		assert.ok(rows.includes("Cache Hit Rate: 84%"), `got: ${rows}`);
		assert.ok(!rows.includes("CH:"), `got: ${rows}`);
	});

	it('shows "Cache Hit Rate: --" when the rate is unavailable', () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 11400;
		footerConfig.cacheWrite = 1200;

		const rows = renderRows(footerConfig, true, false);

		assert.ok(rows.includes("Cache Hit Rate: --"), `got: ${rows}`);
	});

	it("shows neither label nor rate when showCache is false", () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 11400;
		footerConfig.cacheWrite = 1200;
		footerConfig.cacheHitRate = 84;

		const rows = renderRows(footerConfig, false, false);

		assert.ok(!rows.includes("Cache Hit Rate"), `got: ${rows}`);
		assert.ok(!rows.includes("CH:"), `got: ${rows}`);
	});

	it("renders a rate it is given without recomputing it", () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.cacheRead = 11400;
		footerConfig.cacheWrite = 1200;
		// Deliberately not the value the formula would produce: the row must
		// display what state holds, proving no rate math lives in the renderer.
		footerConfig.cacheHitRate = 7;
		const rows = renderRows(footerConfig, true, false);
		assert.ok(rows.includes("Cache Hit Rate: 7%"), `got: ${rows}`);

		footerConfig.cacheHitRate = undefined;
		const rowsUnavailable = renderRows(footerConfig, true, false);
		assert.ok(rowsUnavailable.includes("Cache Hit Rate: --"), `got: ${rowsUnavailable}`);
	});
});

describe("footer row 2 — TPS segment", () => {
	it("marks a computed rate as an estimate", () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.lastComputedTps.value = 42.5;
		const rows = renderRows(footerConfig, false, true);
		assert.ok(rows.includes("~42.5 t/s"), `got: ${rows}`);
	});

	it('shows "-- t/s" when no rate is available', () => {
		const footerConfig = createDefaultFooterConfig();
		footerConfig.lastComputedTps.value = null;
		const rows = renderRows(footerConfig, false, true);
		assert.ok(rows.includes("-- t/s"), `got: ${rows}`);
		assert.ok(!rows.includes("~"), `no estimate marker without a value, got: ${rows}`);
	});
});
