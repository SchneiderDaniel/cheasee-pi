/**
 * agent-event-loop.test.mts — unit tests for the shared handleNormalizedEvent.
 *
 * Injected fakes, no module mocks (runs in the default suite). Guards the
 * normalize → process → workingChange → forward invariant that both the
 * in-process subscriber and the subprocess line handler now share:
 *  - preThinkingText is captured BEFORE processNormalizedEvent clears it
 *  - workingChange drives scheduleFlush + ctx.ui.setWorkingMessage
 *  - chat forwarding is skipped when pi is undefined
 *  - errors from pi.sendMessage propagate (callers own try/catch)
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { handleNormalizedEvent } from "../agent/runner/event-loop.ts";
import { createAgentRunState } from "../agent/state-helpers.ts";
import { createForwardChatState } from "../event/adapter.ts";
import type { NormalizedEvent } from "../event/adapter.ts";
import type { AgentRunState } from "../config/types.ts";

function createCtx(): any {
	return {
		cwd: "/tmp/work",
		ui: {
			notify: mock.fn(),
			setStatus: mock.fn(),
			setWidget: mock.fn(),
			setWorkingMessage: mock.fn(),
		},
	};
}

function harness(opts?: { withPi?: boolean; state?: AgentRunState }) {
	const scheduleFlush = mock.fn();
	const ctx = createCtx();
	const state = opts?.state ?? createAgentRunState(Date.now());
	const pending = createForwardChatState();
	const pi = opts?.withPi === false ? undefined : { sendMessage: mock.fn() };
	const deps = {
		state,
		effectiveCwd: "/tmp/work",
		agentName: "tester",
		pi,
		pending,
		scheduleFlush,
		ctx,
	};
	return { deps, ctx, scheduleFlush, pi, pending, state };
}

describe("handleNormalizedEvent", () => {
	it("captures liveThinking BEFORE processNormalizedEvent clears it", () => {
		const h = harness();
		h.state.liveThinking = "reasoning";

		handleNormalizedEvent({ kind: "thinking_end" } as NormalizedEvent, h.deps);

		assert.equal(h.pi!.sendMessage.mock.callCount(), 1, "one thinking chat message");
		const details = h.pi!.sendMessage.mock.calls[0]!.arguments[0].details;
		assert.equal(details.eventType, "thinking");
		assert.equal(details.content, "reasoning", "content captured before liveThinking cleared");
		assert.equal(h.state.liveThinking, "", "processNormalizedEvent cleared liveThinking");
	});

	it("emits no thinking message for empty/whitespace liveThinking", () => {
		const h = harness();
		h.state.liveThinking = "   ";

		handleNormalizedEvent({ kind: "thinking_end" } as NormalizedEvent, h.deps);

		assert.equal(h.pi!.sendMessage.mock.callCount(), 0);
	});

	it("workingChange true → scheduleFlush once + setWorkingMessage(agent: tool)", () => {
		const h = harness();

		handleNormalizedEvent(
			{ kind: "tool_execution_start", toolName: "bash", args: {} } as NormalizedEvent,
			h.deps,
		);

		assert.equal(h.scheduleFlush.mock.callCount(), 1, "flush scheduled once");
		assert.equal(h.ctx.ui.setWorkingMessage.mock.callCount(), 1, "working message set");
		assert.equal(h.ctx.ui.setWorkingMessage.mock.calls[0]!.arguments[0], "tester: bash");
		assert.equal(h.state.phase, "tool");
	});

	it("workingChange false (turn_start) → no flush, no working message", () => {
		const h = harness();

		handleNormalizedEvent({ kind: "turn_start" } as NormalizedEvent, h.deps);

		assert.equal(h.scheduleFlush.mock.callCount(), 0);
		assert.equal(h.ctx.ui.setWorkingMessage.mock.callCount(), 0);
	});

	it("no-op event (turn_end) → no state change, no flush, no message", () => {
		const h = harness();
		const before = JSON.stringify(h.state);

		handleNormalizedEvent({ kind: "turn_end" } as NormalizedEvent, h.deps);

		assert.equal(JSON.stringify(h.state), before, "state untouched");
		assert.equal(h.scheduleFlush.mock.callCount(), 0);
		assert.equal(h.pi!.sendMessage.mock.callCount(), 0);
	});

	it("pi undefined → no sendMessage, state + flush still driven", () => {
		const h = harness({ withPi: false });

		handleNormalizedEvent(
			{ kind: "tool_execution_start", toolName: "read", args: {} } as NormalizedEvent,
			h.deps,
		);

		assert.equal(h.state.phase, "tool", "state mutated without pi");
		assert.equal(h.scheduleFlush.mock.callCount(), 1, "workingChange still flushes");
	});

	it("full thinking sequence → exactly one thinking message with the captured text", () => {
		const h = harness();

		handleNormalizedEvent({ kind: "thinking_start" } as NormalizedEvent, h.deps);
		handleNormalizedEvent(
			{ kind: "thinking_delta", delta: "first\nsecond" } as NormalizedEvent,
			h.deps,
		);
		handleNormalizedEvent({ kind: "thinking_end" } as NormalizedEvent, h.deps);

		const thinkingCalls = h.pi!.sendMessage.mock.calls.filter(
			(c: any) => c.arguments[0].details.eventType === "thinking",
		);
		assert.equal(thinkingCalls.length, 1, "exactly one thinking message for the turn");
		// handleThinkingDelta flushes complete lines, leaving the partial tail.
		assert.equal(thinkingCalls[0]!.arguments[0].details.content, "second");
		assert.equal(h.state.liveThinking, "", "liveThinking cleared after thinking_end");
	});

	it("shared pending across two tool starts → two forwarded messages, seq advances", () => {
		const h = harness();

		handleNormalizedEvent(
			{ kind: "tool_execution_start", toolName: "bash", args: {} } as NormalizedEvent,
			h.deps,
		);
		handleNormalizedEvent(
			{ kind: "tool_execution_start", toolName: "read", args: {} } as NormalizedEvent,
			h.deps,
		);

		assert.equal(h.pi!.sendMessage.mock.callCount(), 2, "both tool starts forwarded");
		assert.equal(h.pending.toolSeqNum, 2, "shared pending advanced");
	});

	it("pi.sendMessage throwing propagates (callers own try/catch)", () => {
		const h = harness();
		h.state.liveThinking = "boom";
		(h.pi as any).sendMessage = () => {
			throw new Error("sendMessage failed");
		};
		assert.throws(
			() => handleNormalizedEvent({ kind: "thinking_end" } as NormalizedEvent, h.deps),
			/sendMessage failed/,
		);
	});
});
