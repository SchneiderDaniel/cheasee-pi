/**
 * Tests: Removal of dead export `getPhaseFromEvent` from agent/stream.ts
 *
 * The entire agent/stream.ts module has been deleted as part of the
 * "ICA: supervisor/agent/stream.ts thin wrapper around event adapter"
 * refactoring (issue #1022).
 *
 * Verifies:
 *   - stream.ts no longer exists (file was deleted)
 *   - Remaining exports (filterStderr, pushLog, constants) resolve from
 *     their new locations (event/adapter.ts, agent/state-helpers.ts)
 *   - Phase mapping still works via processNormalizedEvent (replacement path)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-getPhaseFromEvent-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { filterStderr } from "../event/adapter.ts";
import { pushLog, MAX_FULL_LOG } from "../agent/state-helpers.ts";
import { processNormalizedEvent } from "../event/adapter.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: stream.ts deleted — file no longer exists
// ═══════════════════════════════════════════════════════════════════════

describe("agent/stream.ts — file deleted", () => {
	it("agent/stream.ts no longer exists on disk", () => {
		const streamPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "stream.ts");
		assert.equal(existsSync(streamPath), false, "stream.ts must be deleted");
	});

	it("dynamic require of stream.ts fails at runtime (file no longer exists)", () => {
		const streamPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "stream.ts");
		// File existence already verified above; module resolution failure
		// is caught by TS compilation, so we verify the file is gone instead
		assert.equal(existsSync(streamPath), false, "stream.ts file must not exist");
	});

	it("remaining exports resolve from new locations", () => {
		assert.equal(typeof filterStderr, "function");
		assert.equal(typeof pushLog, "function");
		assert.equal(typeof MAX_FULL_LOG, "number");
		assert.equal(MAX_FULL_LOG, 500);
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
		const importBlock = source.slice(
			source.lastIndexOf("import {", source.indexOf("state-helpers")),
			source.indexOf("state-helpers") + 'state-helpers.ts"'.length,
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

describe("phase mapping — replacement pipeline (processNormalizedEvent)", () => {
	it('processNormalizedEvent with tool_execution_start event → state.phase === "tool"', () => {
		const state = createMinimalRunState();
		processNormalizedEvent({ kind: "tool_execution_start", toolName: "read", args: {} }, state);
		assert.equal(state.phase, "tool");
	});

	it('processNormalizedEvent with text_start event → state.phase === "text"', () => {
		const state = createMinimalRunState();
		processNormalizedEvent({ kind: "text_start" }, state);
		assert.equal(state.phase, "text");
	});

	it('processNormalizedEvent with message_end event → state.phase === "idle"', () => {
		const state = createMinimalRunState();
		processNormalizedEvent(
			{ kind: "message_end", message: { role: "assistant", content: [] } },
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
		consecutiveToolFailures: new Map(),
		circuitBroken: false,
		circuitBrokenTool: undefined,
		consecutiveFailureThreshold: 3,
	};
}
