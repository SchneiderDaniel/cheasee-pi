/**
 * Tests for FooterState class extracted from index.ts
 *
 * Validates state management, timer lifecycle, TPS sampling,
 * and tool call counting.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/footer-state.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterState } from "../footer-state.ts";
import type { InstallFooterFn } from "../footer-state.ts";
import type { ContextStatusBarConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCtx(): ExtensionContext {
	return {
		ui: {
			setFooter: mock.fn(),
			setStatus: mock.fn(),
			setWidget: mock.fn(),
			setWorkingIndicator: mock.fn(),
			notify: mock.fn(),
			theme: {
				fg: (_color: string, text: string) => text,
			},
		},
		model: { id: "test-model", contextWindow: 128000 },
		getContextUsage: () => ({ tokens: 5000, contextWindow: 128000 }),
		sessionManager: {
			getSessionFile: () => "/tmp/test_12345.jsonl",
		},
		cwd: "/tmp",
	} as unknown as ExtensionContext;
}

/** A minimal config that enables the footer */
const ENABLED_CONFIG: ContextStatusBarConfig = {
	enabled: true,
	thresholds: [{ maxTokens: 100_000 }, { maxTokens: null }],
	showTimer: true,
	showTps: true,
	showCache: true,
	welcomeTimeoutMs: 0,
};

// ---------------------------------------------------------------------------
// FooterState — Construction & defaults
// ---------------------------------------------------------------------------

describe("FooterState — construction & defaults", () => {
	it("FooterState is a class constructor", () => {
		assert.strictEqual(typeof FooterState, "function", "FooterState is a constructor");
	});

	it("creates with default state values", () => {
		const state = new FooterState(createMockCtx());
		assert.strictEqual(state.config, null);
		assert.strictEqual(state.footerConfig.lastContextWindow.value, undefined);
		assert.strictEqual(state.emitted, false);
		assert.strictEqual(state.footerConfig.thinkingLevel, "");
		assert.strictEqual(state.footerConfig.worktreeName, null);
		assert.strictEqual(state.timerInterval, null);
		assert.deepStrictEqual(state.footerConfig.tpsSamples, []);
		assert.strictEqual(state.footerConfig.lastComputedTps.value, null);
		assert.strictEqual(state.lastSampledOutput, undefined);
		assert.strictEqual(state.footerConfig.toolCallCount.value, 0);
		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		// ── New fields (Improvements #1, #2, #4) ───────────────
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
		assert.strictEqual(state.footerConfig.sessionName, undefined);
		assert.strictEqual(state.footerConfig.trustStatus, undefined);
	});

	it("stores ExtensionContext reference", () => {
		const ctx = createMockCtx();
		const state = new FooterState(ctx);
		assert.strictEqual((state as any).ctx, ctx);
	});
});

// ---------------------------------------------------------------------------
// FooterState — addToolCall
// ---------------------------------------------------------------------------

describe("FooterState — addToolCall", () => {
	it("increments toolCallCount", () => {
		const state = new FooterState(createMockCtx());
		assert.strictEqual(state.footerConfig.toolCallCount.value, 0);
		state.addToolCall();
		assert.strictEqual(state.footerConfig.toolCallCount.value, 1);
		state.addToolCall();
		state.addToolCall();
		assert.strictEqual(state.footerConfig.toolCallCount.value, 3);
	});
});

// ---------------------------------------------------------------------------
// FooterState — sampleTps
// ---------------------------------------------------------------------------

describe("FooterState — sampleTps", () => {
	it("ignores undefined output", () => {
		const state = new FooterState(createMockCtx());
		state.sampleTps(undefined);
		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
	});

	it("ignores negative output", () => {
		const state = new FooterState(createMockCtx());
		state.sampleTps(-1);
		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
	});

	it("adds sample with timestamp and cumulative tokens", () => {
		const state = new FooterState(createMockCtx());
		const before = Date.now();
		state.sampleTps(100);
		const after = Date.now();
		assert.strictEqual(state.footerConfig.tpsSamples.length, 1);
		assert.strictEqual(state.footerConfig.tpsSamples[0]!.cumulativeTokens, 100);
		assert.ok(
			state.footerConfig.tpsSamples[0]!.time >= before &&
				state.footerConfig.tpsSamples[0]!.time <= after,
			"timestamp should be in range",
		);
	});

	it("sets lastSampledOutput after sampling", () => {
		const state = new FooterState(createMockCtx());
		state.sampleTps(100);
		assert.strictEqual(state.lastSampledOutput, 100);
	});

	it("detects reset between responses (new response starts from 0)", () => {
		const state = new FooterState(createMockCtx());
		state.sampleTps(100);
		state.sampleTps(200);
		assert.strictEqual(state.footerConfig.tpsSamples.length, 2);

		// Next response starts from 0 again
		state.sampleTps(50); // 50 < 200, should reset
		assert.strictEqual(state.footerConfig.tpsSamples.length, 1); // buffer cleared and new sample added
		assert.strictEqual(state.footerConfig.tpsSamples[0]!.cumulativeTokens, 50);
	});

	it("prunes samples older than 30s", () => {
		const state = new FooterState(createMockCtx());
		const now = Date.now();

		// Push an old sample manually
		state.footerConfig.tpsSamples.push({ time: now - 60_000, cumulativeTokens: 10 });
		state.sampleTps(20);

		// Old sample should be pruned
		assert.strictEqual(state.footerConfig.tpsSamples.length, 1);
		assert.strictEqual(state.footerConfig.tpsSamples[0]!.cumulativeTokens, 20);
	});
});

// ---------------------------------------------------------------------------
// FooterState — startTimer / stopTimer
// ---------------------------------------------------------------------------

describe("FooterState — timer lifecycle", () => {
	let state: FooterState;
	let installFooterMock: ReturnType<typeof mock.fn>;

	beforeEach(() => {
		installFooterMock = mock.fn();
		state = new FooterState(createMockCtx(), installFooterMock as unknown as InstallFooterFn);
	});

	afterEach(() => {
		state.stopTimer();
	});

	it("stopTimer with no active timer is a no-op", () => {
		assert.doesNotThrow(() => state.stopTimer());
		assert.strictEqual(state.timerInterval, null);
	});

	it("startTimer creates an interval", () => {
		state.startTimer();
		assert.ok(state.timerInterval !== null, "timerInterval should be set");
	});

	it("startTimer calls stopTimer first (no duplicate intervals)", () => {
		state.startTimer();
		const first = state.timerInterval;
		state.startTimer();
		assert.ok(state.timerInterval !== null);
		// New interval should be a different handle
		assert.notStrictEqual(state.timerInterval, first);
	});

	it("timer callback calls installFooter when config is set", async () => {
		state.config = ENABLED_CONFIG;
		state.startTimer();

		// Wait for at least one interval tick
		await new Promise((r) => setTimeout(r, 1100));

		assert.ok(installFooterMock.mock.calls.length >= 1, "installFooter should have been called");
	});

	it("timer callback does NOT call installFooter when config is null", async () => {
		state.config = null;
		state.startTimer();

		await new Promise((r) => setTimeout(r, 1100));

		assert.strictEqual(installFooterMock.mock.calls.length, 0);
	});

	it("stopTimer clears the interval", () => {
		state.startTimer();
		state.stopTimer();
		assert.strictEqual(state.timerInterval, null);
	});

	it("after stopTimer, callback is no longer invoked", async () => {
		state.config = ENABLED_CONFIG;
		state.startTimer();
		state.stopTimer();

		// Wait a bit to ensure no more calls
		await new Promise((r) => setTimeout(r, 1100));

		// If timer was started, we might get 0 or 1 call depending on timing
		// After stopTimer, no more calls should happen beyond whatever already fired
		const countAfterStop = installFooterMock.mock.calls.length;
		await new Promise((r) => setTimeout(r, 1100));
		assert.strictEqual(
			installFooterMock.mock.calls.length,
			countAfterStop,
			"call count should not increase after stopTimer",
		);
	});
});

// ---------------------------------------------------------------------------
// FooterState — reset
// ---------------------------------------------------------------------------

describe("FooterState — reset", () => {
	it("resetProperties restores defaults", () => {
		const state = new FooterState(createMockCtx());
		state.config = ENABLED_CONFIG;
		state.footerConfig.lastContextWindow.value = 256000;
		state.emitted = true;
		state.footerConfig.thinkingLevel = "high";
		state.footerConfig.worktreeName = "my-branch";
		state.footerConfig.tpsSamples = [{ time: Date.now(), cumulativeTokens: 100 }];
		state.footerConfig.lastComputedTps.value = 50;
		state.lastSampledOutput = 100;
		state.footerConfig.toolCallCount.value = 5;
		state.footerConfig.cacheRead = 76288;
		state.footerConfig.cacheWrite = 0;
		// ── New fields (Improvements #1, #2, #4) ───────────────
		state.footerConfig.cacheHitRate = 99;
		state.footerConfig.sessionName = "my-session";
		state.footerConfig.trustStatus = "trusted";

		state.resetProperties();

		assert.strictEqual(state.config, null);
		assert.strictEqual(state.footerConfig.lastContextWindow.value, undefined);
		assert.strictEqual(state.emitted, false);
		assert.strictEqual(state.footerConfig.thinkingLevel, "");
		assert.strictEqual(state.footerConfig.worktreeName, null);
		assert.deepStrictEqual(state.footerConfig.tpsSamples, []);
		assert.strictEqual(state.footerConfig.lastComputedTps.value, null);
		assert.strictEqual(state.lastSampledOutput, undefined);
		assert.strictEqual(state.footerConfig.toolCallCount.value, 0);
		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		// ── New fields reset ──────────────────────────────────
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
		assert.strictEqual(state.footerConfig.sessionName, undefined);
		assert.strictEqual(state.footerConfig.trustStatus, undefined);
	});

	it("resetProperties does not clear timerInterval", () => {
		const state = new FooterState(createMockCtx());
		state.startTimer();
		assert.ok(state.timerInterval !== null);

		state.resetProperties();

		// timerInterval should survive reset (stopTimer clears it separately)
		state.stopTimer();
		assert.strictEqual(state.timerInterval, null);
	});
});

// ---------------------------------------------------------------------------
// FooterState — dispose
// ---------------------------------------------------------------------------

describe("FooterState — dispose", () => {
	it("dispose sets disposed = true", () => {
		const state = new FooterState(createMockCtx());
		assert.strictEqual(state.disposed, false);
		state.dispose();
		assert.strictEqual(state.disposed, true);
	});

	it("dispose stops the timer", () => {
		const state = new FooterState(createMockCtx());
		state.startTimer();
		assert.ok(state.timerInterval !== null, "timer should be running");
		state.dispose();
		assert.strictEqual(state.timerInterval, null, "timer should be stopped");
	});

	it("callInstallFooter is no-op when disposed = true", () => {
		const fn = mock.fn();
		const state = new FooterState(createMockCtx(), fn);
		state.dispose();
		state.callInstallFooter();
		assert.strictEqual(fn.mock.calls.length, 0, "should not call installFooterCb when disposed");
	});

	it("callInstallFooter calls installFooterCb when not disposed", () => {
		const fn = mock.fn();
		const state = new FooterState(createMockCtx(), fn);
		state.callInstallFooter();
		assert.strictEqual(fn.mock.calls.length, 1, "should call installFooterCb when not disposed");
	});

	it("addToolCall is no-op when disposed = true", () => {
		const fn = mock.fn();
		const state = new FooterState(createMockCtx(), fn);
		state.dispose();
		state.addToolCall();
		assert.strictEqual(state.footerConfig.toolCallCount.value, 0, "should not increment tool count when disposed");
		// callInstallFooter should also not fire
		assert.strictEqual(fn.mock.calls.length, 0, "should not call installFooterCb when disposed");
	});

	it("dispose is idempotent — calling twice does not error", () => {
		const state = new FooterState(createMockCtx());
		state.dispose();
		assert.doesNotThrow(() => state.dispose());
		assert.strictEqual(state.disposed, true);
	});
});

// ---------------------------------------------------------------------------
// FooterState — installFooter callback integration
// ---------------------------------------------------------------------------

describe("FooterState — installFooter callback integration", () => {
	it("installFooter callback is called with ctx, config, footerConfig", () => {
		const fn = mock.fn();
		const ctx = createMockCtx();
		const state = new FooterState(ctx, fn);
		state.callInstallFooter();
		assert.strictEqual(fn.mock.calls.length, 1);
		assert.strictEqual(fn.mock.calls[0]!.arguments[0], ctx);
		assert.strictEqual(fn.mock.calls[0]!.arguments[1], null);
		assert.strictEqual(fn.mock.calls[0]!.arguments[2], state.footerConfig);
	});

	it("addToolCall increments and calls installFooter", () => {
		const fn = mock.fn();
		const state = new FooterState(createMockCtx(), fn);
		state.addToolCall();
		assert.strictEqual(state.footerConfig.toolCallCount.value, 1);
		assert.strictEqual(fn.mock.calls.length, 1);
	});
});
