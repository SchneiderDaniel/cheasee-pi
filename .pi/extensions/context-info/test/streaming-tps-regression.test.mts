/**
 * Regression tests for issue #2136 — streaming TPS must be available.
 *
 * Reported bug: the footer showed `-- t/s` for an entire generated response.
 * The sampler read `assistantMessageEvent.partial.usage.output`, and providers
 * that only populate output usage at completion never moved that number, so
 * the rolling estimator had a zero token delta.
 *
 * New contract:
 *   - `applyTpsSample` derives its sample from the streamed `message.content`,
 *     not from provider usage.
 *   - `FooterState.beginResponse()` is the only response-scoped reset, driven by
 *     `message_start` for assistant messages. The old decrease-based reset
 *     (`lastSampledOutput`) is gone because an estimate is not monotonic across
 *     all providers (thinking-only deltas) and the heuristic hid real samples.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/streaming-tps-regression.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FooterState, createDefaultFooterConfig } from "../footer-state.ts";
import { applyTpsSample } from "../events-data.ts";
import { registerFooterEvents } from "../events.ts";
import { computeTps } from "../formatting.ts";

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

/** A `message_update` payload whose streamed text grows but usage does not. */
function makeMessageUpdate(streamedText: string, usageOutput = 0) {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text: streamedText }],
			usage: { input: 100, output: usageOutput, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
		},
		assistantMessageEvent: {
			partial: {
				content: [{ type: "text", text: streamedText }],
				usage: { input: 100, output: usageOutput, cacheRead: 0, cacheWrite: 0 },
			},
		},
	};
}

interface CapturingPi {
	pi: ExtensionAPI;
	emit: (event: string, payload: unknown) => void;
	registered: string[];
}

/** Fake ExtensionAPI that keeps the handlers `registerFooterEvents` installs. */
function createCapturingPi(): CapturingPi {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const registered: string[] = [];
	const pi = {
		events: { on: () => () => {} },
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			registered.push(event);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		getSessionName: () => "test-session",
	} as unknown as ExtensionAPI;
	return {
		pi,
		registered,
		emit: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload, {});
		},
	};
}

// ---------------------------------------------------------------------------
// FooterState — beginResponse / resetCacheStats invariants
// ---------------------------------------------------------------------------

describe("FooterState — beginResponse", () => {
	it("clears the sample buffer and the last computed rate", () => {
		const state = makeState();
		state.sampleTps(10);
		state.sampleTps(20);
		state.sampleTps(30);
		state.footerConfig.lastComputedTps.value = 42;
		assert.strictEqual(state.footerConfig.tpsSamples.length, 3);

		state.beginResponse();

		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
		assert.strictEqual(state.footerConfig.lastComputedTps.value, null);
	});
});

describe("FooterState — sampleTps contract", () => {
	it("ignores undefined and negative values", () => {
		const state = makeState();
		state.sampleTps(undefined);
		state.sampleTps(-1);
		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
	});

	it("accepts zero (a zero-token stream is a real sample)", () => {
		const state = makeState();
		state.sampleTps(0);
		assert.strictEqual(state.footerConfig.tpsSamples.length, 1);
	});

	it("no decrease-based reset: 100 then 50 keeps both samples", () => {
		const state = makeState();
		state.sampleTps(100);
		state.sampleTps(50);
		assert.strictEqual(
			state.footerConfig.tpsSamples.length,
			2,
			"only beginResponse() may drop response-scoped samples",
		);
		assert.deepStrictEqual(
			state.footerConfig.tpsSamples.map((s) => s.cumulativeTokens),
			[100, 50],
		);
	});

	it("lastSampledOutput no longer exists on the state", () => {
		const state = makeState();
		assert.strictEqual("lastSampledOutput" in state, false);
		assert.strictEqual((state as unknown as Record<string, unknown>).lastSampledOutput, undefined);
	});
});

describe("FooterState — resetCacheStats", () => {
	it("clears the three cache fields together and leaves everything else alone", () => {
		const state = makeState();
		state.footerConfig.cacheRead = 11400;
		state.footerConfig.cacheWrite = 1200;
		state.footerConfig.cacheHitRate = 83.82;
		state.footerConfig.worktreeName = "feat/branch";
		state.footerConfig.toolCallCount.value = 7;
		state.footerConfig.sessionId = "sess-1";

		state.resetCacheStats();

		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
		assert.strictEqual(state.footerConfig.worktreeName, "feat/branch");
		assert.strictEqual(state.footerConfig.toolCallCount.value, 7);
		assert.strictEqual(state.footerConfig.sessionId, "sess-1");
	});
});

describe("FooterState — resetProperties brings both scopes back to default", () => {
	it("clears samples, last rate and all cache fields", () => {
		const state = makeState();
		state.footerConfig.tpsSamples = [{ time: Date.now(), cumulativeTokens: 100 }];
		state.footerConfig.lastComputedTps.value = 50;
		state.footerConfig.cacheRead = 76288;
		state.footerConfig.cacheWrite = 1024;
		state.footerConfig.cacheHitRate = 99;

		state.resetProperties();

		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
		assert.strictEqual(state.footerConfig.lastComputedTps.value, null);
		assert.strictEqual(state.footerConfig.cacheRead, undefined);
		assert.strictEqual(state.footerConfig.cacheWrite, undefined);
		assert.strictEqual(state.footerConfig.cacheHitRate, undefined);
	});

	it("createDefaultFooterConfig keeps all three cache fields undefined", () => {
		const cfg = createDefaultFooterConfig();
		assert.strictEqual(cfg.cacheRead, undefined);
		assert.strictEqual(cfg.cacheWrite, undefined);
		assert.strictEqual(cfg.cacheHitRate, undefined);
	});
});

// ---------------------------------------------------------------------------
// applyTpsSample — content-derived sampling (the primary regression)
// ---------------------------------------------------------------------------

describe("applyTpsSample — streams without incremental usage", () => {
	it("growing content with constant usage.output yields two samples and a rate", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const state = makeState();

		applyTpsSample(state, makeMessageUpdate("aaaa", 0));
		t.mock.timers.tick(1000);
		applyTpsSample(state, makeMessageUpdate("aaaaaaaaaaaaaaaa", 0));

		assert.strictEqual(state.footerConfig.tpsSamples.length, 2);
		const rate = computeTps(state.footerConfig.tpsSamples);
		assert.ok(rate !== null, "rate must be available when the stream grows");
		assert.ok(rate! > 0, `expected a positive rate, got ${rate}`);
	});

	it("empty event → no throw, no samples", () => {
		const state = makeState();
		assert.doesNotThrow(() => applyTpsSample(state, {}));
		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
	});

	it("message without content → no throw and still no rate", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const state = makeState();

		assert.doesNotThrow(() => applyTpsSample(state, { message: { role: "assistant" } }));
		t.mock.timers.tick(1000);
		assert.doesNotThrow(() => applyTpsSample(state, { message: { role: "assistant" } }));
		assert.strictEqual(computeTps(state.footerConfig.tpsSamples), null);
	});
});

// ---------------------------------------------------------------------------
// registerFooterEvents — message_start drives the response reset
// ---------------------------------------------------------------------------

describe("registerFooterEvents — message_start", () => {
	it("resets the TPS buffer for an assistant message", () => {
		const state = makeState();
		state.sampleTps(10);
		state.sampleTps(20);
		state.footerConfig.lastComputedTps.value = 33;
		const { pi, emit, registered } = createCapturingPi();
		registerFooterEvents(pi, () => state);
		assert.ok(registered.includes("message_start"), "message_start must be subscribed");

		emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });

		assert.strictEqual(state.footerConfig.tpsSamples.length, 0);
		assert.strictEqual(state.footerConfig.lastComputedTps.value, null);
	});

	it("leaves the buffer untouched for a user message", () => {
		const state = makeState();
		state.sampleTps(10);
		state.sampleTps(20);
		const { pi, emit } = createCapturingPi();
		registerFooterEvents(pi, () => state);

		emit("message_start", { type: "message_start", message: { role: "user", content: [] } });

		assert.strictEqual(state.footerConfig.tpsSamples.length, 2);
	});

	it("message_update through the registered handler feeds the estimator", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const state = makeState();
		const { pi, emit } = createCapturingPi();
		registerFooterEvents(pi, () => state);

		emit("message_update", makeMessageUpdate("aaaa", 0));
		t.mock.timers.tick(2000);
		emit("message_update", makeMessageUpdate("aaaaaaaaaaaa", 0));

		assert.strictEqual(state.footerConfig.tpsSamples.length, 2);
		assert.ok(computeTps(state.footerConfig.tpsSamples)! > 0);
	});
});

describe("registerFooterEvents — disposed state is inert", () => {
	it("message_start, message_update and model_select are no-ops", () => {
		const state = makeState();
		state.dispose();
		const before = JSON.stringify(state.footerConfig);
		const { pi, emit } = createCapturingPi();
		registerFooterEvents(pi, () => state);

		assert.doesNotThrow(() => {
			emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
			emit("message_update", makeMessageUpdate("streamed text", 0));
			emit("model_select", { model: { contextWindow: 256000 } });
		});
		assert.strictEqual(JSON.stringify(state.footerConfig), before);
	});
});
