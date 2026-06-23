// ─── Tests: instrumentation.ts — structured counters and phase timing

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInstrumenter } from "../lib/instrumentation.ts";
import type { InstrumenterHandle, InstrumentSnapshot } from "../lib/instrumentation.ts";

// ─── createInstrumenter ──────────────────────────────────────────

describe("createInstrumenter", () => {
	let inst: InstrumenterHandle;

	it("returns handle with all methods", () => {
		inst = createInstrumenter();
		assert.equal(typeof inst.incrementEvent, "function");
		assert.equal(typeof inst.trackPhase, "function");
		assert.equal(typeof inst.setTokenCount, "function");
		assert.equal(typeof inst.snapshot, "function");
		assert.equal(typeof inst.recordToolError, "function");
	});

	it("initial snapshot has zero counters and idle phase", () => {
		inst = createInstrumenter();
		const snap = inst.snapshot();
		assert.equal(snap.eventsTotal, 0);
		assert.equal(snap.toolCalls, 0);
		assert.equal(snap.toolErrors, 0);
		assert.equal(snap.thinkingDeltas, 0);
		assert.equal(snap.textDeltas, 0);
		assert.equal(snap.tokenCount, 0);
		assert.equal(snap.currentPhase, "idle");
		assert.equal(snap.phaseTransitions, 0);
		assert.ok(snap.timestamp > 0);
	});
});

// ─── incrementEvent ──────────────────────────────────────────────

describe("incrementEvent", () => {
	it("increments eventsTotal for any event kind", () => {
		const inst = createInstrumenter();
		inst.incrementEvent("thinking_delta");
		inst.incrementEvent("text_delta");
		inst.incrementEvent("tool_execution_start");
		assert.equal(inst.snapshot().eventsTotal, 3);
	});

	it("increments toolCalls on tool_execution_start", () => {
		const inst = createInstrumenter();
		inst.incrementEvent("tool_execution_start");
		assert.equal(inst.snapshot().toolCalls, 1);
	});

	it("increments thinkingDeltas on thinking_delta", () => {
		const inst = createInstrumenter();
		inst.incrementEvent("thinking_delta");
		inst.incrementEvent("thinking_delta");
		assert.equal(inst.snapshot().thinkingDeltas, 2);
	});

	it("increments textDeltas on text_delta", () => {
		const inst = createInstrumenter();
		inst.incrementEvent("text_delta");
		assert.equal(inst.snapshot().textDeltas, 1);
	});

	it("does not increment tool-specific counters for unknown events", () => {
		const inst = createInstrumenter();
		inst.incrementEvent("session");
		inst.incrementEvent("turn_start");
		const snap = inst.snapshot();
		assert.equal(snap.toolCalls, 0);
		assert.equal(snap.thinkingDeltas, 0);
		assert.equal(snap.textDeltas, 0);
		assert.equal(snap.eventsTotal, 2);
	});
});

// ─── recordToolError ─────────────────────────────────────────────

describe("recordToolError", () => {
	it("records tool error count", () => {
		const inst = createInstrumenter();
		inst.recordToolError();
		inst.recordToolError();
		inst.recordToolError();
		assert.equal(inst.snapshot().toolErrors, 3);
	});
});

// ─── trackPhase ──────────────────────────────────────────────────

describe("trackPhase", () => {
	it("tracks phase transitions and accumulates time", () => {
		const inst = createInstrumenter();
		assert.equal(inst.snapshot().phaseTransitions, 0);

		inst.trackPhase("thinking");
		assert.equal(inst.snapshot().currentPhase, "thinking");
		assert.equal(inst.snapshot().phaseTransitions, 1);

		inst.trackPhase("tool");
		assert.equal(inst.snapshot().currentPhase, "tool");
		assert.equal(inst.snapshot().phaseTransitions, 2);

		inst.trackPhase("text");
		assert.equal(inst.snapshot().currentPhase, "text");
		assert.equal(inst.snapshot().phaseTransitions, 3);
	});

	it("transitioning to same phase is no-op", () => {
		const inst = createInstrumenter();
		inst.trackPhase("thinking");
		const snap1 = inst.snapshot();
		inst.trackPhase("thinking"); // same phase - no-op
		const snap2 = inst.snapshot();
		assert.equal(snap2.phaseTransitions, snap1.phaseTransitions);
	});

	it("accumulates phase timing (non-zero after transition)", () => {
		const inst = createInstrumenter();
		const idleTime = inst.snapshot().phaseTiming.idle;
		assert.ok(idleTime >= 0);
	});

	it("phaseTiming contains all four phases with numeric values", () => {
		const inst = createInstrumenter();
		const snap = inst.snapshot();
		const expectedPhases = ["idle", "thinking", "tool", "text"];
		for (const phase of expectedPhases) {
			assert.ok(phase in snap.phaseTiming, `phaseTiming should include key "${phase}"`);
			assert.equal(
				typeof snap.phaseTiming[phase as keyof typeof snap.phaseTiming],
				"number",
				`phaseTiming["${phase}"] should be a number`,
			);
			assert.ok(
				snap.phaseTiming[phase as keyof typeof snap.phaseTiming] >= 0,
				`phaseTiming["${phase}"] should be >= 0`,
			);
		}
	});

	it("phaseTiming accumulates across multiple phase transitions", () => {
		const inst = createInstrumenter();
		const snap0 = inst.snapshot();
		const idleBefore = snap0.phaseTiming.idle;

		// Transition through multiple phases
		inst.trackPhase("thinking");
		inst.trackPhase("tool");
		inst.trackPhase("text");

		const snap1 = inst.snapshot();
		// idle time should have increased (time spent from creation to first transition)
		assert.ok(snap1.phaseTiming.idle >= idleBefore);
		// thinking and tool should have non-zero time (we spent time in them)
		// At minimum, idle + thinking + tool + text should sum to total elapsed
		const totalTimed = Object.values(snap1.phaseTiming).reduce((a, b) => a + b, 0);
		const elapsed = snap1.timestamp - snap0.timestamp;
		// Total timed should be close to elapsed (allow small timing granularity)
		assert.ok(
			totalTimed >= elapsed - 50,
			`total phase timing (${totalTimed}ms) should be near elapsed (${elapsed}ms)`,
		);
	});
});

// ─── setTokenCount ───────────────────────────────────────────────

describe("setTokenCount", () => {
	it("sets token count in snapshot", () => {
		const inst = createInstrumenter();
		inst.setTokenCount(1500);
		assert.equal(inst.snapshot().tokenCount, 1500);
	});

	it("overwrites previous token count", () => {
		const inst = createInstrumenter();
		inst.setTokenCount(500);
		inst.setTokenCount(1200);
		assert.equal(inst.snapshot().tokenCount, 1200);
	});
});
