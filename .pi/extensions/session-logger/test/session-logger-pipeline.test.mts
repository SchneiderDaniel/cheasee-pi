/**
 * Tests for session-logger/pipeline.ts — LoggerPipeline class
 *
 * Verifies that event handlers delegate correctly to stats/file tracking.
 * Uses mock gate and inspects internal state via the exposed getStats().
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-pipeline.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { LoggerPipeline, beginSession } from "../pipeline.ts";
import type { SessionLoggerGate } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGate(enabled = true): SessionLoggerGate {
	return { enabledForNextSession: enabled, sessionEnabled: enabled };
}

// ---------------------------------------------------------------------------
// beginSession
// ---------------------------------------------------------------------------

describe("beginSession", () => {
	it("copies enabledForNextSession to sessionEnabled — returns true when enabled", () => {
		const gate = createGate(true);
		gate.enabledForNextSession = true;
		const result = beginSession(gate);
		assert.strictEqual(result, true);
		assert.strictEqual(gate.sessionEnabled, true);
	});

	it("copies enabledForNextSession to sessionEnabled — returns false when disabled", () => {
		const gate = createGate(false);
		gate.enabledForNextSession = false;
		const result = beginSession(gate);
		assert.strictEqual(result, false);
		assert.strictEqual(gate.sessionEnabled, false);
	});

	it("disabling after start — returns false, sessionEnabled matches enabledForNextSession", () => {
		const gate = createGate(true);
		beginSession(gate); // sessionEnabled = true, enabledForNextSession = true
		gate.enabledForNextSession = false;
		const result = beginSession(gate); // copies false
		assert.strictEqual(result, false);
		assert.strictEqual(gate.sessionEnabled, false);
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — construction
// ---------------------------------------------------------------------------

describe("LoggerPipeline construction", () => {
	it("creates pipeline with gate", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		assert.ok(pipeline instanceof LoggerPipeline);
	});

	it("getFiles returns file ops", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		assert.ok(pipeline.getFiles());
		assert.ok(typeof pipeline.getFiles().ensureSymlink === "function");
	});

	it("initial sessionFile and sessionsDir are undefined", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		assert.strictEqual(pipeline.getSessionFile(), undefined);
		assert.strictEqual(pipeline.getSessionsDir(), undefined);
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — event handlers with gate disabled (no-ops)
// ---------------------------------------------------------------------------

describe("LoggerPipeline event handlers — gate disabled", () => {
	it("onSessionCompact is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		const stats = pipeline.getStats();
		const snapBefore = stats.getSnapshot();
		assert.strictEqual(snapBefore.compactionCount, 0);

		pipeline.onSessionCompact();
		const snapAfter = stats.getSnapshot();
		assert.strictEqual(snapAfter.compactionCount, 0, "should not increment when disabled");
	});

	it("onModelSelect is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.modelChanges.length, 0);
	});

	it("onTurnStart is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onTurnStart({ turnIndex: 0 });
		// Should not throw
	});

	it("onToolExecutionStart is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "bash" });
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.toolExecutions.length, 0);
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — event handlers with gate enabled
// ---------------------------------------------------------------------------

describe("LoggerPipeline event handlers — gate enabled", () => {
	it("onSessionCompact increments compaction count", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onSessionCompact();
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.compactionCount, 1);
	});

	it("onModelSelect records model change", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.modelChanges.length, 1);
		assert.ok(snap.modelChanges[0].model.includes("openai/gpt-4"));
	});

	it("onThinkingLevelSelect records thinking change", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onThinkingLevelSelect({ level: "high" });
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.thinkingChanges.length, 1);
		assert.strictEqual(snap.thinkingChanges[0].level, "high");
	});

	it("onTurnStart and onTurnEnd record per-turn stats", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onTurnStart({ turnIndex: 0 });
		pipeline.onTurnEnd();
		const snap = pipeline.getStats().getSnapshot();
		assert.ok(Array.isArray(snap.perTurnTokens));
	});

	it("onMessageEnd with assistant message records usage", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onMessageEnd({
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } },
			},
		});
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 100);
		assert.strictEqual(snap.totalOutputTokens, 50);
	});

	it("onMessageEnd with non-assistant message is no-op", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onMessageEnd({
			message: {
				role: "user",
				usage: { input: 100, output: 0, totalTokens: 100 },
			},
		});
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 0, "user messages should not track usage");
	});

	it("onToolExecutionStart records tool execution", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "bash" });
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.toolExecutions.length, 1);
		assert.strictEqual(snap.toolExecutions[0].toolName, "bash");
	});

	it("onToolExecutionEnd completes tool execution", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "output" }] },
			isError: false,
		});
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.toolExecutions.length, 1);
		assert.ok(snap.toolExecutions[0].endTime != null, "endTime should be set");
	});

	it("onToolExecutionEnd with error sets isError", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-err", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-err",
			result: { content: [{ type: "text", text: "error output" }] },
			isError: true,
		});
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.toolExecutions[0].isError, true);
	});

	it("multiple tool executions tracked independently", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "read" });
		pipeline.onToolExecutionStart({ toolCallId: "call-2", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "data" }] },
			isError: false,
		});
		pipeline.onToolExecutionEnd({
			toolCallId: "call-2",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.toolExecutions.length, 2);
		assert.strictEqual(snap.toolExecutions[0].toolName, "read");
		assert.strictEqual(snap.toolExecutions[1].toolName, "bash");
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — onToolCall file modification tracking
// ---------------------------------------------------------------------------

describe("LoggerPipeline onToolCall — file modification tracking", () => {
	it("track read tool call", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "read",
			input: { path: "/tmp/test.txt" },
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 1);
		assert.strictEqual(snap.fileModifications[0].action, "read");
		assert.strictEqual(snap.fileModifications[0].path, "/tmp/test.txt");
	});

	it("track write tool call with size", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c2",
			toolName: "write",
			input: { path: "/tmp/test.txt", content: { length: 42 } },
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 1);
		assert.strictEqual(snap.fileModifications[0].action, "write");
		assert.strictEqual(snap.fileModifications[0].size, 42);
	});

	it("track edit tool call", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c3",
			toolName: "edit",
			input: { path: "/tmp/test.txt" },
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 1);
		assert.strictEqual(snap.fileModifications[0].action, "edit");
	});

	it("is no-op when gate is disabled", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c4",
			toolName: "read",
			input: { path: "/tmp/test.txt" },
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 0);
	});

	it("input with no path field defaults to empty string", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c5",
			toolName: "read",
			input: {},
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 1);
		assert.strictEqual(snap.fileModifications[0].path, "");
	});

	it("input with path empty string works correctly", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c6",
			toolName: "read",
			input: { path: "" },
		} as any);
		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.fileModifications.length, 1);
		assert.strictEqual(snap.fileModifications[0].path, "");
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — snapshot access
// ---------------------------------------------------------------------------

describe("LoggerPipeline — snapshot access", () => {
	it("getStats().getSnapshot() returns current state", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onSessionCompact();
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });

		const snap = pipeline.getStats().getSnapshot();
		assert.strictEqual(snap.compactionCount, 1);
		assert.strictEqual(snap.modelChanges.length, 1);
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — onSessionStart wiring (partial, no sessionManager mock)
// ---------------------------------------------------------------------------

describe("LoggerPipeline onSessionStart", () => {
	it("requires sessionManager with getSessionFile and getCwd", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		// Provide a minimal mock — onSessionStart checks gate first,
		// then calls getSessionFile. If getSessionFile returns undefined,
		// it returns early.
		let calledFile = false;
		const ctx = {
			sessionManager: {
				getSessionFile: () => {
					calledFile = true;
					return undefined; // triggers early return
				},
				getCwd: () => "/tmp",
				getEntries: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any);
		assert.ok(calledFile, "getSessionFile should be called");
		assert.strictEqual(pipeline.getSessionFile(), undefined);
	});

	it("with overrides stores sessionName and mode on pipeline", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
				getCwd: () => "/tmp",
				getEntries: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any, {
			sessionName: "fix-bug-123",
			mode: "tui",
		});
		assert.strictEqual(pipeline.getSessionName(), "fix-bug-123");
		assert.strictEqual(pipeline.getMode(), "tui");
	});

	it("without overrides keeps sessionName and mode as undefined", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
				getCwd: () => "/tmp",
				getEntries: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any);
		assert.strictEqual(pipeline.getSessionName(), undefined);
		assert.strictEqual(pipeline.getMode(), undefined);
	});

	it("with gate disabled does not store overrides", async () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getCwd: () => "/tmp",
				getEntries: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any, {
			sessionName: "fix-bug-123",
			mode: "tui",
		});
		assert.strictEqual(pipeline.getSessionName(), undefined);
		assert.strictEqual(pipeline.getMode(), undefined);
	});
});
