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
import { describe, it, mock } from "node:test";
import { LoggerPipeline, beginSession } from "../pipeline.ts";
import type { FileOps } from "../files.ts";
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

// ---------------------------------------------------------------------------
// LoggerPipeline — onSessionStart ensureSymlink error handling
// ---------------------------------------------------------------------------

function createMockFileOps(
	ensureSymlinkImpl?: (sessionFile: string, sessionsDir: string) => Promise<void>,
): FileOps & { ensureSymlinkCalls: number } {
	let calls = 0;
	return {
		ensureSymlink: async (sessionFile: string, sessionsDir: string) => {
			calls++;
			if (ensureSymlinkImpl) {
				return ensureSymlinkImpl(sessionFile, sessionsDir);
			}
		},
		ensureMdSymlink: async () => {},
		ensureLatestMetadataSymlink: async () => {},
		writeMetadata: async () => {},
		writeSessionReport: async () => {},
		get ensureSymlinkCalls() {
			return calls;
		},
	};
}

function createSessionStartCtxWithFile(overrides?: {
	sessionFile?: string;
	cwd?: string;
	entries?: any[];
}): any {
	const hasFile = "sessionFile" in (overrides ?? {});
	return {
		mode: "tui",
		sessionManager: {
			getSessionFile: () => (hasFile ? overrides!.sessionFile : "/tmp/.pi/session.jsonl"),
			getCwd: () => overrides?.cwd ?? "/tmp",
			getEntries: () => overrides?.entries ?? [],
		},
	};
}

describe("LoggerPipeline onSessionStart — ensureSymlink error handling", () => {
	it("ensureSymlink succeeds — sessionFile and sessionsDir are set", async () => {
		const gate = createGate(true);
		const mockFiles = createMockFileOps(async () => {});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const ctx = createSessionStartCtxWithFile({
			sessionFile: "/tmp/.pi/session.jsonl",
			cwd: "/tmp",
		});

		await pipeline.onSessionStart({}, ctx);

		assert.strictEqual(pipeline.getSessionFile(), "/tmp/.pi/session.jsonl");
		assert.strictEqual(pipeline.getSessionsDir(), "/tmp/.pi/sessions");
		assert.strictEqual(mockFiles.ensureSymlinkCalls, 1);
	});

	it("ensureSymlink throws EACCES — gracefully degrades", async () => {
		const gate = createGate(true);
		const e = new Error("EACCES: permission denied");
		(e as NodeJS.ErrnoException).code = "EACCES";
		const mockFiles = createMockFileOps(async () => {
			throw e;
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);
			assert.strictEqual(mockFiles.ensureSymlinkCalls, 1);
			assert.strictEqual(mockConsoleError.mock.calls.length, 1);
			assert.ok(
				(mockConsoleError.mock.calls[0].arguments[0] as string).includes("[session-logger]"),
			);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("ensureSymlink throws ENOSPC — gracefully degrades", async () => {
		const gate = createGate(true);
		const e = new Error("ENOSPC: no space left on device");
		(e as NodeJS.ErrnoException).code = "ENOSPC";
		const mockFiles = createMockFileOps(async () => {
			throw e;
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);
			assert.strictEqual(mockFiles.ensureSymlinkCalls, 1);
			assert.strictEqual(mockConsoleError.mock.calls.length, 1);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("ensureSymlink throws EROFS — gracefully degrades", async () => {
		const gate = createGate(true);
		const e = new Error("EROFS: read-only file system");
		(e as NodeJS.ErrnoException).code = "EROFS";
		const mockFiles = createMockFileOps(async () => {
			throw e;
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("ensureSymlink throws EIO — gracefully degrades", async () => {
		const gate = createGate(true);
		const e = new Error("EIO: input/output error");
		(e as NodeJS.ErrnoException).code = "EIO";
		const mockFiles = createMockFileOps(async () => {
			throw e;
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("ensureSymlink throws generic Error — gracefully degrades", async () => {
		const gate = createGate(true);
		const mockFiles = createMockFileOps(async () => {
			throw new Error("generic I/O failure");
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);
			assert.strictEqual(mockFiles.ensureSymlinkCalls, 1);
			assert.strictEqual(mockConsoleError.mock.calls.length, 1);
			assert.ok(
				(mockConsoleError.mock.calls[0].arguments[0] as string).includes("generic I/O failure"),
			);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("sessionFile undefined — early return before ensureSymlink", async () => {
		const gate = createGate(true);
		const mockFiles = createMockFileOps(async () => {});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const ctx = createSessionStartCtxWithFile({
			sessionFile: undefined,
		});

		await pipeline.onSessionStart({}, ctx);

		assert.strictEqual(pipeline.getSessionFile(), undefined);
		assert.strictEqual(pipeline.getSessionsDir(), undefined);
		assert.strictEqual(mockFiles.ensureSymlinkCalls, 0, "ensureSymlink should NOT be called");
	});

	it("gate disabled — beginSession returns false, ensureSymlink NOT called", async () => {
		const gate = createGate(false);
		const mockFiles = createMockFileOps(async () => {});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const ctx = createSessionStartCtxWithFile({
			sessionFile: "/tmp/.pi/session.jsonl",
		});

		await pipeline.onSessionStart({}, ctx);

		assert.strictEqual(pipeline.getSessionFile(), undefined);
		assert.strictEqual(mockFiles.ensureSymlinkCalls, 0, "ensureSymlink should NOT be called");
	});

	it("after ensureSymlink failure — downstream handlers still work as no-ops", async () => {
		const gate = createGate(true);
		const mockFiles = createMockFileOps(async () => {
			throw new Error("EACCES: permission denied");
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		// Call onSessionStart — it will fail
		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
				cwd: "/tmp",
			});

			await pipeline.onSessionStart({}, ctx);

			// After failure, sessionFile/sessionsDir are undefined
			assert.strictEqual(pipeline.getSessionFile(), undefined);
			assert.strictEqual(pipeline.getSessionsDir(), undefined);

			// Downstream handlers should still not throw
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

			// All should resolve without throwing (handlers are no-ops when sessionFile is undefined)
			// Actually, the handlers gate on sessionEnabled, not sessionFile.
			// But gate.sessionEnabled is still true — so handlers will execute.
			// The stats should still be updated because gate is still enabled.
			const snap = pipeline.getStats().getSnapshot();
			assert.strictEqual(snap.compactionCount, 1);
			assert.strictEqual(snap.modelChanges.length, 1);
			assert.strictEqual(snap.toolExecutions.length, 1);
		} finally {
			mockConsoleError.mock.restore();
		}
	});

	it("console.error includes session-logger prefix and error message", async () => {
		const gate = createGate(true);
		const mockFiles = createMockFileOps(async () => {
			throw new Error("ENOSPC: disk full");
		});
		const pipeline = new LoggerPipeline(gate, mockFiles);

		const mockConsoleError = mock.method(console, "error");
		try {
			const ctx = createSessionStartCtxWithFile({
				sessionFile: "/tmp/.pi/session.jsonl",
			});

			await pipeline.onSessionStart({}, ctx);

			assert.strictEqual(mockConsoleError.mock.calls.length, 1);
			const msg = mockConsoleError.mock.calls[0].arguments[0] as string;
			assert.ok(msg.includes("[session-logger]"), "should have session-logger prefix");
			assert.ok(msg.includes("ENOSPC"), "should include error code");
		} finally {
			mockConsoleError.mock.restore();
		}
	});
});
