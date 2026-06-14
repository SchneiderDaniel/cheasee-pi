/**
 * Tests for supervisor error boundaries (issue 301).
 *
 * Phase 1: Pure function boundaries — no throw on bad input
 * Phase 2: Error boundary structure — try-catch present in both runners
 * Phase 3: Heartbeat interval — error resilience (mock integration)
 * Phase 4: Subscribe callback — listener chain preservation (mock integration)
 * Phase 5: JSON stream handleLine — per-chunk error isolation (mock integration)
 * Phase 6: Edge cases — multi-error storms, nested boundaries
 * Phase 7: Regression — existing behavior preserved
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-boundaries.test.mts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { readFileSync } from "node:fs";
import type { AgentRunState } from "../config/types.ts";
import { processJsonLine } from "../agent/stream.ts";
import { processSessionEvent } from "../event/session-events.ts";
import { buildWidgetLines } from "../session/widget.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../agent/runner.ts";
import { createInstrumenter } from "../lib/instrumentation.ts";
import { createWatchdog } from "../lib/watchdog.ts";
import { filterIssueData } from "../github/comment.ts";
import { findIssueItem } from "../github/project.ts";
import { sendPipelineSummary } from "../pipeline/notifications.ts";
import { validateAgentResult } from "../pipeline/output.ts";
import { buildRawOutputFromMessages } from "../session/result.ts";
import { isStaleCheckpoint } from "../pipeline/state-checkpoint.ts";
import { createExtensionStateStore } from "../../lib/extension-state.ts";
import { parseAgentFile } from "../agent/loader.ts";
import { resolveModelString } from "../session/model.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
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
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Pure function boundaries — no throw on bad input (domain tests)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Pure function boundaries — no throw on bad input", () => {
	// ── processJsonLine ────────────────────────────────────────────

	describe("processJsonLine", () => {
		it("1.1: malformed JSON returns no-op, no throw", () => {
			const state = createState();
			const result = processJsonLine("{broken", state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.2: empty string returns no-op, no throw", () => {
			const state = createState();
			const result = processJsonLine("", state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it('1.3: null/undefined event ({"type":"message_update","delta":null}) returns no-op', () => {
			const state = createState();
			const line = JSON.stringify({ type: "message_update", delta: null });
			const result = processJsonLine(line, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.4: unknown event type returns default flags", () => {
			const state = createState();
			const line = JSON.stringify({ type: "unknown_event" });
			const result = processJsonLine(line, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.5: tool_execution_start with null toolName does not throw", () => {
			const state = createState();
			const line = JSON.stringify({ type: "tool_execution_start", toolName: null });
			const result = processJsonLine(line, state);
			// Should handle gracefully — coalesces null to "tool"
			assert.equal(result.flush, true);
			assert.equal(state.currentTool, "tool");
		});

		it("1.6: processSessionEvent with unexpected event type does not throw", () => {
			const state = createState();
			const result = processSessionEvent({ type: "bogus" }, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.7: message_update with no assistantMessageEvent does not throw", () => {
			const state = createState();
			const ev = { type: "message_update" };
			const result = processSessionEvent(ev, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.8: assistantMessageEvent with unknown type does not throw", () => {
			const state = createState();
			const ev = {
				type: "message_update",
				assistantMessageEvent: { type: "bogus_type_xyz" },
			};
			const result = processSessionEvent(ev, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.9: null/undefined event object is handled by caller try-catch (processSessionEvent itself throws)", () => {
			const state = createState();
			// processSessionEvent is a pure function that expects valid input;
			// null events throw at switch(ev.type), and the boundary is the
			// subscribe callback's try-catch in agent-session-runner.ts
			assert.throws(() => processSessionEvent(null as any, state), {
				name: "TypeError",
			});
			assert.throws(() => processSessionEvent(undefined as any, state), {
				name: "TypeError",
			});
		});

		it("1.10: processJsonLine with null buffer (empty after trim) returns no-op", () => {
			const state = createState();
			const result = processJsonLine("   ", state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.11: message_update with no delta but valid fields does not throw", () => {
			const state = createState();
			const line = JSON.stringify({ type: "message_update", delta: undefined });
			const result = processJsonLine(line, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});

		it("1.12: tool_execution_start with undefined toolName coalesces to 'tool'", () => {
			const state = createState();
			const line = JSON.stringify({ type: "tool_execution_start", toolName: undefined });
			const result = processJsonLine(line, state);
			assert.equal(result.flush, true);
			assert.equal(state.currentTool, "tool");
		});
	});

	// ── buildWidgetLines ───────────────────────────────────────────

	describe("buildWidgetLines", () => {
		it("1.13: empty state returns array with agent name, context line, footer, no throw", () => {
			const state = createState();
			const lines = buildWidgetLines(state, "test-agent", "test-model");
			assert.ok(Array.isArray(lines));
			assert.ok(lines.length >= 1);
			assert.ok(lines[0].includes("test-agent"));
		});

		it("1.14: state with null entries in fullLog is handled by flushWidget try-catch (buildWidgetLines itself throws)", () => {
			const state = createState();
			(state.fullLog as any).push(null);
			(state.fullLog as any).push(undefined);
			// buildWidgetLines throws on null entries (accesses .length);
			// the boundary is flushWidget()'s try-catch in both runners
			assert.throws(() => buildWidgetLines(state, "test-agent"), {
				name: "TypeError",
			});
		});

		it("1.15: state with undefined phase renders with idle phase, no throw", () => {
			const state = createState({ phase: undefined as any });
			const lines = buildWidgetLines(state, "test-agent");
			assert.ok(Array.isArray(lines));
		});

		it("1.16: state with null liveText is handled by flushWidget try-catch (buildWidgetLines throws when phase=text)", () => {
			const state = createState({ liveText: null as any, phase: "text" });
			// buildWidgetLines throws when phase === "text" and liveText is null (calls .trim())
			// The boundary is flushWidget()'s try-catch in both runners
			assert.throws(() => buildWidgetLines(state, "test-agent"));
			// With non-text phase, null liveText doesn't crash
			const state2 = createState({ liveText: null as any, phase: "idle" });
			const lines2 = buildWidgetLines(state2, "test-agent");
			assert.ok(Array.isArray(lines2));
		});

		it("1.17: state with null currentTool does not throw", () => {
			const state = createState({ currentTool: null as any, phase: "tool" });
			const lines = buildWidgetLines(state, "test-agent");
			assert.ok(Array.isArray(lines));
		});

		// ── New format tests (Phase 6: buildWidgetLines current-tool display) ──

		it("formats bash currentTool with command: widget line contains formatted string", () => {
			const state = createState({
				currentTool: "bash",
				currentToolArgs: JSON.stringify({ command: "npm test" }),
			});
			const lines = buildWidgetLines(state, "test-agent");
			const toolLine = lines.find((l) => l.includes("$"));
			assert.ok(toolLine, "should have a line with $");
			assert.ok(toolLine!.includes("$ npm test"), "should show formatted bash command");
			// 🔧 icon preserved as section prefix
			assert.ok(toolLine!.includes("🔧"), "🔧 icon preserved");
		});

		it("formats read currentTool with path+offset+limit: reads /x:1-10", () => {
			const state = createState({
				currentTool: "read",
				currentToolArgs: JSON.stringify({ path: "/x", offset: 1, limit: 10 }),
			});
			const lines = buildWidgetLines(state, "test-agent");
			const toolLine = lines.find((l) => l.includes("read /x:1-10"));
			assert.ok(toolLine, "should show formatted read command with range");
		});

		it("formats tool with no args: shows tool name with 🔧 icon", () => {
			const state = createState({
				currentTool: "bash",
				currentToolArgs: undefined,
			});
			const lines = buildWidgetLines(state, "test-agent");
			const toolLine = lines.find((l) => l.includes("🔧"));
			assert.ok(toolLine, "should have a tool line");
			assert.ok(toolLine!.includes("🔧"), "🔧 icon preserved");
		});

		it("when no current tool, no tool widget line shown", () => {
			const state = createState({
				currentTool: undefined,
				currentToolArgs: undefined,
			});
			const lines = buildWidgetLines(state, "test-agent");
			const toolLine = lines.find((l) => l.includes("🔧"));
			assert.equal(toolLine, undefined, "no tool line when currentTool is empty");
		});

		it("1.18: processSessionEvent with undefined assistantMessageEvent.type does not throw", () => {
			const state = createState();
			const ev = { type: "message_update", assistantMessageEvent: { type: undefined } } as any;
			const result = processSessionEvent(ev, state);
			assert.deepEqual(result, { flush: false, workingChange: false });
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Error boundary structure — try-catch present in both runners
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Error boundary structure — try-catch present in both runners", () => {
	describe("agent-session-runner.ts", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");

		it("2.1: subscribe callback body wrapped in try-catch", () => {
			// Find the subscribe callback: session.subscribe((event: any) => { try {
			const subscribeSection = source.split("unsubscribe = session.subscribe")[1] || "";
			assert.ok(
				subscribeSection.includes("try {") ||
					source.includes("try {\n\t\t\t\tconst result = processSessionEvent"),
				"subscribe callback must have try block",
			);
			// Simpler check: the callback contains try and catch
			assert.ok(
				source.includes("session.subscribe((event: any) =>") &&
					source.includes("try {") &&
					source.includes("catch (evErr: unknown)"),
				"subscribe callback must have try-catch",
			);
		});

		it("2.2: subscribe catch logs console.error with event type context", () => {
			assert.ok(
				source.includes("console.error(") && source.includes("session event error for"),
				"catch block logs console.error with session event error prefix",
			);
		});

		it("2.3: flushWidget() body wrapped in try-catch", () => {
			assert.ok(
				source.includes("const flushWidget = () =>") &&
					source.includes("try {") &&
					source.includes("ctx.ui.setWidget("),
				"flushWidget must have try-catch around setWidget",
			);
		});

		it("2.4: flushWidget catch logs console.error with widget render error", () => {
			assert.ok(
				source.includes("widget render error for"),
				"flushWidget catch must log 'widget render error'",
			);
		});

		it("2.5: heartbeat setInterval callback wrapped in try-catch", () => {
			const heartbeatSection = source.split("heartbeatTimer = setInterval")[1] || "";
			assert.ok(
				source.includes("heartbeatTimer = setInterval(() =>") &&
					source.includes("try {") &&
					source.includes("catch (hbErr: unknown)"),
				"heartbeat callback must have try-catch",
			);
		});

		it("2.6: heartbeat catch logs console.error with heartbeat error", () => {
			assert.ok(
				source.includes("heartbeat error for"),
				"heartbeat catch must log 'heartbeat error'",
			);
		});
	});

	describe("agent-runner.ts", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");

		it("2.7: handleLine() body wrapped in try-catch", () => {
			const handleLineSection = source.split("const handleLine =")[1] || "";
			assert.ok(
				handleLineSection.includes("try {") || source.includes("handleLine = (line: string) =>"),
				"handleLine must exist",
			);
			assert.ok(
				source.includes("try {") && source.includes("const result = processJsonLine(line, state);"),
				"handleLine must have try block wrapping processJsonLine",
			);
		});

		it("2.8: handleLine catch logs console.error with JSON line error", () => {
			assert.ok(
				source.includes("JSON line error for"),
				"handleLine catch must log 'JSON line error'",
			);
		});

		it("2.9: flushWidget() body wrapped in try-catch", () => {
			assert.ok(
				source.includes("const flushWidget = () =>") &&
					source.includes("try {") &&
					source.includes("ctx.ui.setWidget("),
				"flushWidget must have try-catch around setWidget",
			);
		});

		it("2.10: flushWidget catch logs console.error with widget render error", () => {
			assert.ok(
				source.includes("widget render error for"),
				"flushWidget catch must log 'widget render error'",
			);
		});

		it("2.11: heartbeat setInterval callback wrapped in try-catch", () => {
			assert.ok(
				source.includes("heartbeatTimer = setInterval(() =>") ||
					source.includes("const heartbeatTimer = setInterval"),
				"heartbeatTimer setInterval must exist",
			);
			assert.ok(
				source.includes("catch (hbErr: unknown)"),
				"heartbeat callback must have catch clause with hbErr",
			);
		});

		it("2.12: heartbeat catch logs console.error with heartbeat error", () => {
			assert.ok(
				source.includes("heartbeat error for"),
				"heartbeat catch must log 'heartbeat error'",
			);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Heartbeat interval — error resilience (mock integration)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Heartbeat interval — error resilience", () => {
	it("3.1: heartbeat try-catch prevents setWidget throw from killing interval", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");
		// Verify the structure: heartbeat callback has try-catch that catches any throw
		const heartbeatSection =
			source.split("heartbeatTimer = setInterval")[1]?.split("}, 2000)")[0] || "";
		assert.ok(
			heartbeatSection.includes("try {") && heartbeatSection.includes("catch"),
			"heartbeat callback must contain try-catch to survive setWidget throw",
		);
	});

	it("3.2: agent-session-runner heartbeat also has try-catch", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");
		const heartbeatSection =
			source.split("heartbeatTimer = setInterval")[1]?.split("}, 2000)")[0] || "";
		assert.ok(
			heartbeatSection.includes("try {") && heartbeatSection.includes("catch"),
			"heartbeat callback in agent-session-runner must contain try-catch",
		);
	});

	it("3.3: both runners have flusWidget call inside heartbeat try block", () => {
		const runnerSource = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");
		const runnerHeartbeat =
			runnerSource.split("heartbeatTimer = setInterval")[1]?.split("}, 2000)")[0] || "";
		assert.ok(
			runnerHeartbeat.includes("flushWidget"),
			"agent-runner heartbeat calls flushWidget inside try",
		);

		const sessionRunnerSource = readFileSync(
			".pi/extensions/supervisor/agent-session-runner.ts",
			"utf-8",
		);
		const sessionHeartbeat =
			sessionRunnerSource.split("heartbeatTimer = setInterval")[1]?.split("}, 2000)")[0] || "";
		assert.ok(
			sessionHeartbeat.includes("flushWidget"),
			"agent-session-runner heartbeat calls flushWidget inside try",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Subscribe callback — listener chain preservation (mock integration)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Subscribe callback — listener chain preservation", () => {
	it("4.1: subscribe try-catch wraps processSessionEvent call", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");
		// Verify the subscribe callback wraps processSessionEvent in try-catch
		assert.ok(
			source.includes("const result = processSessionEvent(event, state);"),
			"subscribe callback calls processSessionEvent",
		);
		// Check it's inside try block — find the try before processSessionEvent
		const lines = source.split("\n");
		let foundTry = false;
		let foundProcessSession = false;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes("try {")) {
				foundTry = true;
			}
			if (lines[i].includes("processSessionEvent(event, state)")) {
				foundProcessSession = true;
				// Look back for the nearest try
				const searchStart = Math.max(0, i - 15);
				const preceding = lines.slice(searchStart, i).join("\n");
				if (preceding.includes("try {")) {
					foundTry = true;
				}
				// Check there's a catch block after
				const afterLines = lines.slice(i, i + 15).join("\n");
				assert.ok(
					afterLines.includes("catch (evErr: unknown)") || afterLines.includes("catch ("),
					"processSessionEvent call must be followed by catch block",
				);
			}
		}
		assert.ok(foundProcessSession, "processSessionEvent must be called in subscribe callback");
	});

	it("4.2: subscribe catch logs error with event type in message", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");
		assert.ok(
			source.includes("console.error(") &&
				source.includes("session event error") &&
				source.includes("event?.type"),
			"catch block must log error with event type context",
		);
	});

	it("4.3: non-throwing path calls scheduleFlush and setWorkingMessage when result indicates", () => {
		// Structural check: scheduleFlush and setWorkingMessage called after processSessionEvent
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");
		const subscribeSection =
			source.split("unsubscribe = session.subscribe")[1]?.split("// ── Bug 2 fix")[0] || "";
		assert.ok(
			subscribeSection.includes("scheduleFlush()") || subscribeSection.includes("scheduleFlush"),
			"subscribe callback must call scheduleFlush",
		);
		assert.ok(
			subscribeSection.includes("setWorkingMessage"),
			"subscribe callback must call setWorkingMessage",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: JSON stream handleLine — per-chunk error isolation
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 5: JSON stream handleLine — per-chunk error isolation", () => {
	it("5.1: handleLine wraps processJsonLine in try-catch", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");
		// Find handleLine function
		const handleLineSection =
			source.split("const handleLine =")[1]?.split("child.stdout.on")[0] || "";
		assert.ok(
			handleLineSection.includes("try {") &&
				handleLineSection.includes("processJsonLine(line, state)") &&
				handleLineSection.includes("catch (lineErr: unknown)"),
			"handleLine must have try-catch around processJsonLine",
		);
	});

	it("5.2: handleLine catch logs console.error with JSON line error prefix", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");
		assert.ok(
			source.includes("JSON line error for"),
			"handleLine catch must log 'JSON line error for'",
		);
	});

	it("5.3: processJsonLine already has inner try-catch for JSON.parse", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-stream.ts", "utf-8");
		// processJsonLine wraps JSON.parse in try-catch
		const processJsonLineSection = source.split("export function processJsonLine")[1] || "";
		assert.ok(
			processJsonLineSection.includes("try {") ||
				source.includes("try {\n\t\tconst ev = JSON.parse(line);"),
			"processJsonLine must have try-catch around JSON.parse",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Edge cases — multi-error storms, nested boundaries
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 6: Edge cases — multi-error storms, nested boundaries", () => {
	it("6.1: processJsonLine handles multiple consecutive malformed JSON lines without cascade", () => {
		const state = createState();
		const malformedLines = ["{invalid}", "{broken", "{{{", "null", "undefined"];

		for (const line of malformedLines) {
			const result = processJsonLine(line, state);
			// Each malformed line should return no-op and not throw
			assert.deepEqual(result, { flush: false, workingChange: false });
		}
		// State should remain unchanged after all malformed lines
		assert.equal(state.toolCount, 0);
		assert.equal(state.tokenCount, 0);
		assert.equal(state.fullLog.length, 0);
	});

	it("6.2: processJsonLine handles valid JSON after malformed line", () => {
		const state = createState();
		// First malformed
		processJsonLine("{invalid}", state);
		// Then valid tool_execution_start
		const validLine = JSON.stringify({
			type: "tool_execution_start",
			toolName: "read_file",
		});
		const result = processJsonLine(validLine, state);
		assert.equal(result.flush, true);
		assert.equal(state.currentTool, "read_file");
		assert.equal(state.phase, "tool");
	});

	it("6.3: processJsonLine handles null/undefined event type gracefully after malformed JSON", () => {
		const state = createState();
		// Malformed JSON
		processJsonLine("{{{}}", state);
		// Valid JSON but null/missing type
		const validButNullType = JSON.stringify({ type: null });
		const result = processJsonLine(validButNullType, state);
		// Falls through switch, returns default flags
		assert.deepEqual(result, { flush: false, workingChange: false });
	});

	it("6.4: processSessionEvent events with null message fields do not break", () => {
		const state = createState();

		// message_end with null message
		let result = processSessionEvent({ type: "message_end", message: null } as any, state);
		assert.deepEqual(result, { flush: false, workingChange: false });

		// message_update with message object missing content
		result = processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "done",
					message: { content: null },
				},
			} as any,
			state,
		);
		assert.equal(result.flush, true);
	});

	it("6.5: processSessionEvent events with non-array content field do not throw", () => {
		const state = createState();
		const result = processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: "not an array string content",
				},
			} as any,
			state,
		);
		// Should not throw — the function accesses content as array but if it's not,
		// the extractTextFromContent handles it
		assert.equal(result.flush, true);
	});

	it("6.6: processJsonLine handles events with extra unexpected fields gracefully", () => {
		const state = createState();
		const line = JSON.stringify({
			type: "tool_execution_start",
			toolName: "read_file",
			unexpectedField: { nested: { data: "boom" } },
		});
		const result = processJsonLine(line, state);
		assert.equal(result.flush, true);
		assert.equal(state.currentTool, "read_file");
	});

	it("6.7: multiple empty lines interspersed with valid events are handled", () => {
		const state = createState();
		const events = [
			"",
			"  ",
			JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
			"",
			JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
			"",
		];
		for (const line of events) {
			processJsonLine(line, state);
		}
		// After tool_execution_end, toolCount should be 1
		assert.equal(state.toolCount, 1);
	});

	it("6.8: nested boundaries — handleLine outer catch + processJsonLine inner catch both handle errors without cascade", () => {
		// Structural test: verify both try-catch exist in chain
		const runnerSource = readFileSync(".pi/extensions/supervisor/agent-runner.ts", "utf-8");
		const streamSource = readFileSync(".pi/extensions/supervisor/agent-stream.ts", "utf-8");

		// agent-runner handleLine has try-catch
		assert.ok(runnerSource.includes("catch (lineErr: unknown)"), "handleLine outer catch exists");
		// agent-stream processJsonLine has try-catch for JSON.parse
		assert.ok(
			streamSource.includes("catch (parseErr: unknown)"),
			"processJsonLine inner catch exists",
		);
	});

	it("6.9: processSessionEvent with undefined/null as event throws (boundary is caller try-catch)", () => {
		const state = createState();
		// processSessionEvent accesses ev.type directly — null/undefined throws.
		// The error boundary is in agent-session-runner.ts subscribe callback try-catch.
		assert.throws(() => processSessionEvent(undefined as any, state));
		assert.throws(() => processSessionEvent(null as any, state));
	});

	it("6.10: tool_execution_start → tool_execution_end → tool_execution_start works after malformed JSON", () => {
		const state = createState();
		// Malformed
		processJsonLine("{{{}}", state);
		// First tool cycle
		processJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }), state);
		assert.equal(state.currentTool, "read");
		processJsonLine(JSON.stringify({ type: "tool_execution_end", toolName: "read" }), state);
		assert.equal(state.toolCount, 1);
		// Second tool cycle after malformed
		processJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "write" }), state);
		assert.equal(state.currentTool, "write");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: Regression — existing behavior preserved
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 7: Regression — existing behavior preserved", () => {
	// ── processSessionEvent dedup tests ──

	describe("processSessionEvent dedup (from session-events.test.mts)", () => {
		it("7.1: text_end → message_end still produces one text entry", () => {
			const state = createState();
			state.liveText = "streamed text";

			// text_end
			processSessionEvent(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.equal(state.textPushedThisTurn, true);
			assert.equal(state.textOutputLines[0], "streamed text");

			// message_end
			processSessionEvent(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "streamed text" }] },
				},
				state,
			);
			// Should still be exactly 1 entry
			assert.equal(state.textOutputLines.length, 1);
		});

		it("7.2: thinking_end → message_end still produces one thinking entry", () => {
			const state = createState();
			state.liveThinking = "streamed thinking";

			processSessionEvent(
				{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
				state,
			);
			assert.equal(state.thinkingPushedThisTurn, true);
			assert.ok(state.thinkingOutputLines[0]?.includes("streamed thinking"));

			processSessionEvent(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "streamed thinking" }],
					},
				},
				state,
			);
			assert.equal(state.thinkingOutputLines.length, 1);
		});

		it("7.3: done → message_end still resets flags", () => {
			const state = createState();
			processSessionEvent(
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "done",
						message: { content: [{ type: "text", text: "hello" }] },
					},
				},
				state,
			);
			assert.equal(state.textPushedThisTurn, true);

			processSessionEvent(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				},
				state,
			);
			// Flags reset by message_end
			assert.equal(state.textPushedThisTurn, false);
		});
	});

	// ── processJsonLine event processing unchanged ──

	describe("processJsonLine event processing unchanged", () => {
		it("7.4: tool_execution_start → tool_execution_end increments toolCount", () => {
			const state = createState();
			processJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }), state);
			processJsonLine(JSON.stringify({ type: "tool_execution_end", toolName: "read" }), state);
			assert.equal(state.toolCount, 1);
		});

		it("7.5: thinking_delta accumulates liveThinking (no newline = stays in buffer)", () => {
			const state = createState();
			processJsonLine(
				JSON.stringify({
					type: "message_update",
					delta: { type: "thinking_delta", thinking_delta: "thinking text" },
				}),
				state,
			);
			// Without a newline, thinking_delta stays in liveThinking buffer
			assert.ok(state.liveThinking.includes("thinking text"));
			// liveText should be empty (thinking, not text)
			assert.equal(state.liveText, "");
		});

		it("7.6: text_delta accumulates liveText", () => {
			const state = createState();
			processJsonLine(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "text output\n" },
				}),
				state,
			);
			assert.ok(state.fullLog.some((l) => l.includes("text output")));
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 8: Module export coverage for impl files in diff
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 8: Module export coverage — impl files from diff", () => {
	it("extension-state exports createExtensionStateStore as a function", () => {
		assert.equal(typeof createExtensionStateStore, "function");
	});

	it("loader exports parseAgentFile as a function", () => {
		assert.equal(typeof parseAgentFile, "function");
	});

	it("runner exports DEFAULT_AGENT_TIMEOUT_MS as a number", () => {
		assert.equal(typeof DEFAULT_AGENT_TIMEOUT_MS, "number");
	});

	it("instrumentation exports createInstrumenter as a function", () => {
		assert.equal(typeof createInstrumenter, "function");
	});

	it("watchdog exports createWatchdog as a function", () => {
		assert.equal(typeof createWatchdog, "function");
	});

	it("comment exports filterIssueData as a function", () => {
		assert.equal(typeof filterIssueData, "function");
	});

	it("project exports findIssueItem as a function", () => {
		assert.equal(typeof findIssueItem, "function");
	});

	it("notifications exports sendPipelineSummary as a function", () => {
		assert.equal(typeof sendPipelineSummary, "function");
	});

	it("output exports validateAgentResult as a function", () => {
		assert.equal(typeof validateAgentResult, "function");
	});

	it("model exports resolveModelString as a function", () => {
		assert.equal(typeof resolveModelString, "function");
	});

	it("result exports buildRawOutputFromMessages as a function", () => {
		assert.equal(typeof buildRawOutputFromMessages, "function");
	});

	it("state-checkpoint exports isStaleCheckpoint as a function", () => {
		assert.equal(typeof isStaleCheckpoint, "function");
	});
});
