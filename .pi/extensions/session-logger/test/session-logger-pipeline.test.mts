/**
 * Tests for session-logger/pipeline.ts — LoggerPipeline class
 *
 * Verifies that event handlers delegate correctly to stats/file tracking.
 * Uses real temp directories for filesystem assertions.
 * Stats aggregation is tested in session-logger-stats.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-pipeline.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { LoggerPipeline, beginSession } from "../pipeline.ts";
import type { SessionLoggerGate } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGate(enabled = true): SessionLoggerGate {
	return { enabledForNextSession: enabled, sessionEnabled: enabled };
}

/**
 * Create a mock sessionManager with a real temp dir backing.
 * Writes an empty session file at the returned path.
 */
function createSessionManager(
	tmpDir: string,
	overrides?: {
		sessionFile?: string;
		cwd?: string;
		entries?: any[];
	},
): any {
	const sessionsDir = path.join(tmpDir, ".pi", "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const sessionFile = overrides?.sessionFile ?? path.join(sessionsDir, "session-test.jsonl");
	if (!fs.existsSync(sessionFile)) {
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				id: "test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				version: 1,
			}) + "\n",
		);
	}

	return {
		getSessionFile: () => sessionFile,
		getCwd: () => overrides?.cwd ?? tmpDir,
		getBranch: () => overrides?.entries ?? [],
	};
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
});

// ---------------------------------------------------------------------------
// LoggerPipeline — event handlers with gate disabled (no-ops)
// ---------------------------------------------------------------------------

describe("LoggerPipeline event handlers — gate disabled", () => {
	it("onSessionCompact is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		// Should not throw
		pipeline.onSessionCompact();
	});

	it("onModelSelect is no-op when gate.sessionEnabled is false", () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
		// Should not throw
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
		// Should not throw
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — event handlers with gate enabled
// ---------------------------------------------------------------------------

describe("LoggerPipeline event handlers — gate enabled", () => {
	it("onSessionCompact does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onSessionCompact();
	});

	it("onModelSelect does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
	});

	it("onThinkingLevelSelect does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onThinkingLevelSelect({ level: "high" });
	});

	it("onTurnStart and onTurnEnd do not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onTurnStart({ turnIndex: 0 });
		pipeline.onTurnEnd();
	});

	it("onMessageEnd with assistant message does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onMessageEnd({
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } },
			},
		});
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
	});

	it("onToolExecutionStart and onToolExecutionEnd do not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "output" }] },
			isError: false,
		});
	});

	it("onToolExecutionEnd with error does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolExecutionStart({ toolCallId: "call-err", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-err",
			result: { content: [{ type: "text", text: "error output" }] },
			isError: true,
		});
	});

	it("multiple tool executions tracked independently do not throw", () => {
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
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — onToolCall file modification tracking
// ---------------------------------------------------------------------------

describe("LoggerPipeline onToolCall — file modification tracking", () => {
	it("track read tool call does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "read",
			input: { path: "/tmp/test.txt" },
		} as any);
	});

	it("track write tool call with size does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c2",
			toolName: "write",
			input: { path: "/tmp/test.txt", content: { length: 42 } },
		} as any);
	});

	it("track edit tool call does not throw", () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);
		pipeline.onToolCall({
			type: "tool_call",
			toolCallId: "c3",
			toolName: "edit",
			input: { path: "/tmp/test.txt" },
		} as any);
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
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — onSessionStart with real temp directory
// ---------------------------------------------------------------------------

describe("LoggerPipeline onSessionStart — FS assertions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-pipeline-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("with valid sessionFile creates latest.jsonl symlink on disk", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: createSessionManager(tmpDir),
		};

		await pipeline.onSessionStart({}, ctx as any);

		// latest.jsonl symlink should exist
		const latestLink = path.join(tmpDir, ".pi", "sessions", "latest.jsonl");
		assert.ok(fs.existsSync(latestLink), "latest.jsonl should exist on disk");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.jsonl should be a symlink");
	});

	it("with sessionFile returning undefined — no symlink created, no error", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any);

		// No symlink should be created
		const latestLink = path.join(tmpDir, ".pi", "sessions", "latest.jsonl");
		assert.ok(
			!fs.existsSync(latestLink),
			"latest.jsonl should NOT exist when sessionFile is undefined",
		);
	});

	it("with gate disabled — no symlink created", async () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);

		const ctx = {
			sessionManager: createSessionManager(tmpDir),
		};

		await pipeline.onSessionStart({}, ctx as any);

		const latestLink = path.join(tmpDir, ".pi", "sessions", "latest.jsonl");
		assert.ok(!fs.existsSync(latestLink), "latest.jsonl should NOT exist when gate is disabled");
	});

	it("after EACCES (via chmod on sessions dir) — gracefully degrades, console.error logged", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		// Create sessions dir and make it read-only to force EACCES
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.chmodSync(sessionsDir, 0o000);

		const sessionFile = path.join(sessionsDir, "session-test.jsonl");
		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		const mockConsoleError = mock.method(console, "error");
		try {
			await pipeline.onSessionStart({}, ctx as any);

			// Should not throw — gracefully degraded
			assert.strictEqual(mockConsoleError.mock.calls.length, 1);
			assert.ok(
				(mockConsoleError.mock.calls[0].arguments[0] as string).includes("[session-logger]"),
			);
		} finally {
			mockConsoleError.mock.restore();
			// Restore permissions so cleanup works
			fs.chmodSync(sessionsDir, 0o755);
		}
	});

	it("after failure — downstream handlers still work without crashing", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		// Make sessions dir read-only to force failure
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.chmodSync(sessionsDir, 0o000);

		const sessionFile = path.join(sessionsDir, "session-test.jsonl");
		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		const mockConsoleError = mock.method(console, "error");
		try {
			await pipeline.onSessionStart({}, ctx as any);
			mockConsoleError.mock.restore();

			// Downstream handlers should not throw
			pipeline.onSessionCompact();
			pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
			pipeline.onThinkingLevelSelect({ level: "high" });
			pipeline.onTurnStart({ turnIndex: 0 });
			pipeline.onTurnEnd();
			pipeline.onMessageEnd({
				message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } },
			});
			pipeline.onToolExecutionStart({ toolCallId: "c1", toolName: "bash" });
			pipeline.onToolExecutionEnd({
				toolCallId: "c1",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			});
			pipeline.onToolCall({
				toolName: "read",
				input: { path: "/tmp/test.txt" },
			} as any);
		} finally {
			// Restore permissions so cleanup works
			fs.chmodSync(sessionsDir, 0o755);
		}
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — onSessionShutdown with real temp directory
// ---------------------------------------------------------------------------
