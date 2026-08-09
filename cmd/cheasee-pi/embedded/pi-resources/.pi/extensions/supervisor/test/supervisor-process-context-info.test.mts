/**
 * Tests for supervisor context-info handling in processJsonLine() and buildWidgetLines().
 *
 * Pure function extracted from runAgent() closure for testability.
 * Tests cover:
 * - Phase 3b: processJsonLine() context_info event handling
 * - Phase 3c: buildWidgetLines() context line rendering
 * - Phase 3d: fullLog context info appending
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-process-context-info.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicate pure functions from supervisor.ts for isolated unit testing
// (matches .pi/extensions/supervisor.ts implementation exactly)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

interface ContextInfoState {
	contextTokens?: number;
	contextWindow?: number;
	contextInfoReceived: boolean;
	fullLog: string[];
}

/**
 * Pure function: process a JSON line and update context-info state.
 * Returns true if state was mutated (widget flush needed).
 */
function handleContextJsonLine(line: string, state: ContextInfoState): boolean {
	if (!line.trim()) return false;
	try {
		const ev = JSON.parse(line);
		if (ev.type !== "context_info") return false;

		const tokens = ev.contextTokens;
		const window = ev.contextWindow;

		if (typeof tokens !== "number" || typeof window !== "number") return false;
		if (window <= 0) return false;

		state.contextTokens = tokens;
		state.contextWindow = window;
		state.contextInfoReceived = true;
		state.fullLog.push(`📊 Context: ${formatTokens(tokens)}/${formatTokens(window)} (initial)`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pure function: build widget lines given state.
 */
function buildContextWidgetLines(state: ContextInfoState): string[] {
	const lines: string[] = [];
	if (
		state.contextInfoReceived &&
		state.contextTokens !== undefined &&
		state.contextWindow !== undefined
	) {
		lines.push(
			`Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`,
		);
	} else {
		lines.push("Context: computing...");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Phase 3b — processJsonLine() context_info event handling
// ---------------------------------------------------------------------------

describe("handleContextJsonLine — context_info event handling", () => {
	let state: ContextInfoState;

	beforeEach(() => {
		state = {
			contextInfoReceived: false,
			fullLog: [],
		};
	});

	it("P3.5: context_info with valid numbers → state mutated", () => {
		const line = '{"type":"context_info","contextTokens":12400,"contextWindow":256000}';
		const mutated = handleContextJsonLine(line, state);

		assert.ok(mutated);
		assert.strictEqual(state.contextTokens, 12400);
		assert.strictEqual(state.contextWindow, 256000);
		assert.ok(state.contextInfoReceived);
		assert.strictEqual(state.fullLog.length, 1);
		assert.ok(state.fullLog[0].includes("Context:"));
	});

	it("P3.6: context_info with zero window → ignored", () => {
		const line = '{"type":"context_info","contextTokens":0,"contextWindow":0}';
		const mutated = handleContextJsonLine(line, state);

		assert.ok(!mutated);
		assert.ok(!state.contextInfoReceived);
	});

	it("P3.7: context_info missing contextWindow → ignored", () => {
		const line = '{"type":"context_info","contextTokens":12400}';
		const mutated = handleContextJsonLine(line, state);

		assert.ok(!mutated);
		assert.ok(!state.contextInfoReceived);
	});

	it("P3.8: non-JSON line → ignored, no crash", () => {
		const line = "some random stdout text";
		const mutated = handleContextJsonLine(line, state);

		assert.ok(!mutated);
		assert.ok(!state.contextInfoReceived);
	});

	it("P3.9: other JSON event type → ignored", () => {
		const line = '{"type":"session","id":"abc"}';
		const mutated = handleContextJsonLine(line, state);

		assert.ok(!mutated);
		assert.ok(!state.contextInfoReceived);
	});

	it("P3.10: two context_info events → last wins", () => {
		const line1 = '{"type":"context_info","contextTokens":12400,"contextWindow":256000}';
		const line2 = '{"type":"context_info","contextTokens":8000,"contextWindow":128000}';

		handleContextJsonLine(line1, state);
		handleContextJsonLine(line2, state);

		assert.strictEqual(state.contextTokens, 8000);
		assert.strictEqual(state.contextWindow, 128000);
		assert.strictEqual(state.fullLog.length, 2);
	});

	it("P3.11: multiple event types interleaved → context_info handled independently", () => {
		const toolLine = '{"type":"tool_execution_start","toolName":"read"}';
		const ctxLine = '{"type":"context_info","contextTokens":5000,"contextWindow":128000}';
		const msgLine = '{"type":"message_end","message":{"role":"assistant"}}';

		handleContextJsonLine(toolLine, state);
		handleContextJsonLine(ctxLine, state);
		handleContextJsonLine(msgLine, state);

		assert.ok(state.contextInfoReceived);
		assert.strictEqual(state.contextTokens, 5000);
	});
});

// ---------------------------------------------------------------------------
// Phase 3c — buildWidgetLines() context line rendering
// ---------------------------------------------------------------------------

describe("buildContextWidgetLines — context line rendering", () => {
	it("P3.12: before context_info arrives → computing placeholder", () => {
		const state: ContextInfoState = {
			contextInfoReceived: false,
			fullLog: [],
		};
		const lines = buildContextWidgetLines(state);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], "Context: computing...");
	});

	it("P3.13: before context_info, has tokens → computing placeholder", () => {
		const state: ContextInfoState = {
			contextInfoReceived: false,
			contextTokens: 5000,
			contextWindow: 128000,
			fullLog: [],
		};
		const lines = buildContextWidgetLines(state);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], "Context: computing...");
	});

	it("P3.14: after context_info arrives → formatted line", () => {
		const state: ContextInfoState = {
			contextInfoReceived: true,
			contextTokens: 12400,
			contextWindow: 256000,
			fullLog: [],
		};
		const lines = buildContextWidgetLines(state);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], "Context: 12.4K/256.0K");
	});

	it("P3.15: small token numbers", () => {
		const state: ContextInfoState = {
			contextInfoReceived: true,
			contextTokens: 50,
			contextWindow: 4096,
			fullLog: [],
		};
		const lines = buildContextWidgetLines(state);
		assert.strictEqual(lines[0], "Context: 50/4.1K");
	});

	it("P3.16: million-scale tokens", () => {
		const state: ContextInfoState = {
			contextInfoReceived: true,
			contextTokens: 1_500_000,
			contextWindow: 8_192_000,
			fullLog: [],
		};
		const lines = buildContextWidgetLines(state);
		assert.strictEqual(lines[0], "Context: 1.5M/8.2M");
	});
});

// ---------------------------------------------------------------------------
// Phase 3d — fullLog context info appending
// ---------------------------------------------------------------------------

describe("fullLog context info appending", () => {
	let state: ContextInfoState;

	beforeEach(() => {
		state = {
			contextInfoReceived: false,
			fullLog: [],
		};
	});

	it("P3.17: context_info received → fullLog contains formatted line", () => {
		const line = '{"type":"context_info","contextTokens":12400,"contextWindow":256000}';
		handleContextJsonLine(line, state);

		assert.strictEqual(state.fullLog.length, 1);
		assert.strictEqual(state.fullLog[0], "📊 Context: 12.4K/256.0K (initial)");
	});

	it("P3.18: context_info with no contextWindow → no line appended", () => {
		const line = '{"type":"context_info","contextTokens":12400}';
		handleContextJsonLine(line, state);

		assert.strictEqual(state.fullLog.length, 0);
	});
});
