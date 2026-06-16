/**
 * Tests: Removal of dead export `getPhaseFromEvent` from agent/stream.ts
 *
 * Verifies the function is no longer exported, remaining exports still
 * resolve, header comment is updated, stale JSDoc is removed, and the
 * replacement pipeline (processJsonLine → jsonLineToNormalizedEvent →
 * processNormalizedEvent) still produces correct phase transitions.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-getPhaseFromEvent-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_FULL_LOG,
	WIDGET_LINES,
	MAX_LIVE_THINKING,
	filterStderr,
	pushLog,
	processJsonLine,
} from "../agent/stream.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Dead export removed — getPhaseFromEvent no longer exported
// ═══════════════════════════════════════════════════════════════════════

describe("getPhaseFromEvent — dead export removed", () => {
	it("dynamic import of getPhaseFromEvent from agent/stream.ts throws or is undefined", async () => {
		// Dynamic import resolves the module, then we check the named export
		const mod = await import("../agent/stream.ts");
		assert.equal(
			(mod as any).getPhaseFromEvent,
			undefined,
			"getPhaseFromEvent must not be a named export from agent/stream.ts",
		);
	});

	it("remaining exports still resolve as functions/constants", () => {
		assert.equal(typeof filterStderr, "function");
		assert.equal(typeof pushLog, "function");
		assert.equal(typeof processJsonLine, "function");
		assert.equal(typeof MAX_FULL_LOG, "number");
		assert.equal(typeof WIDGET_LINES, "number");
		assert.equal(typeof MAX_LIVE_THINKING, "number");
		assert.ok(MAX_FULL_LOG > 0);
		assert.ok(WIDGET_LINES > 0);
	});

	it("header comment at stream.ts no longer mentions getPhaseFromEvent() in 'Owns' list", () => {
		const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "stream.ts");
		const source = readFileSync(sourcePath, "utf-8");
		const ownsLine = source.split("\n").find((l) => l.includes("Owns:"));
		assert.ok(ownsLine, "should find 'Owns:' line in header comment");
		assert.ok(
			!ownsLine!.includes("getPhaseFromEvent"),
			"Owns line must not mention getPhaseFromEvent()",
		);
	});

	it("stale JSDoc block at lines 68-69 is removed (no 'Preserved for backward compat' note)", () => {
		const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "stream.ts");
		const source = readFileSync(sourcePath, "utf-8");
		assert.ok(
			!source.includes("Preserved for backward compat"),
			"source must not contain 'Preserved for backward compat' anywhere",
		);
	});

	it("function body getPhaseFromEvent no longer exists in source file", () => {
		const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "stream.ts");
		const source = readFileSync(sourcePath, "utf-8");
		assert.ok(
			!source.includes("export function getPhaseFromEvent"),
			"source must not contain 'export function getPhaseFromEvent'",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Contract test assertion removed from config-lib-refactor.test.mts
// ═══════════════════════════════════════════════════════════════════════

describe("config-lib-refactor.test.mts — contract test removed", () => {
	it("config-lib-refactor.test.mts import line no longer imports getPhaseFromEvent", () => {
		const testPath = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"config-lib-refactor.test.mts",
		);
		const source = readFileSync(testPath, "utf-8");
		// The import block should not contain 'getPhaseFromEvent'
		const importLine = source
			.split("\n")
			.find((l) => l.includes("from") && l.includes("agent/stream.ts"));
		const importBlock = source.slice(
			source.lastIndexOf("import {", source.indexOf("agent/stream.ts")),
			source.indexOf("agent/stream.ts") + 'agent/stream.ts"'.length,
		);
		assert.ok(
			!importBlock.includes("getPhaseFromEvent"),
			"import block must not mention getPhaseFromEvent",
		);
	});

	it('it("agent/stream.ts exports getPhaseFromEvent", ...) block is removed', () => {
		const testPath = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"config-lib-refactor.test.mts",
		);
		const source = readFileSync(testPath, "utf-8");
		assert.ok(
			!source.includes('exports getPhaseFromEvent"'),
			'test description "agent/stream.ts exports getPhaseFromEvent" must not exist',
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Phase mapping still works via replacement path
// ═══════════════════════════════════════════════════════════════════════

describe("phase mapping — replacement pipeline (processJsonLine → processNormalizedEvent)", () => {
	it('processJsonLine with tool_execution_start JSON line → state.phase === "tool"', () => {
		const state = createMinimalRunState();
		processJsonLine(
			JSON.stringify({
				type: "tool_execution_start",
				name: "read",
				input: "{}",
			}),
			state,
		);
		assert.equal(state.phase, "tool");
	});

	it('processJsonLine with text_delta in message_update → state.phase === "text"', () => {
		const state = createMinimalRunState();
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		assert.equal(state.phase, "text");
	});

	it('processJsonLine with message_end → state.phase === "idle"', () => {
		const state = createMinimalRunState();
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.phase, "idle");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function createMinimalRunState() {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle" as const,
		startedAt: Date.now(),
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
	};
}
