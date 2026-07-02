/**
 * Phase 2: Adapter — auditFileGroup notification error handling
 *
 * Tests auditFileGroup via injected LspRuntime (setLspRuntime/resetLspRuntime).
 * Each test controls sendNotification behavior via mockConnection to verify
 * try/catch + await patterns, openedUris.add move, and .catch() on exit.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/lsp-auditor/test/lsp-client.test.mts
 *
 * No --experimental-test-module-mocks flag needed.
 */

import assert from "node:assert";
import { beforeEach, afterEach, describe, it, mock } from "node:test";
import { PassThrough } from "node:stream";
import type { ServerMapping, LspRuntime, JsonRpcModule } from "../types.ts";
import { auditFileGroup, setLspRuntime, resetLspRuntime } from "../lsp-client.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

const TS_MAPPING: ServerMapping = {
	extensions: [".ts"],
	command: "typescript-language-server",
	args: ["--stdio"],
	severityThreshold: "warning",
};

const SINGLE_FILE = ["src/test.ts"];
const EMPTY_FILES: string[] = [];

// ─── Mock factories ──────────────────────────────────────────────────

/** Shared mutable connection mock — reset per test */
let mockConnection: any = null;

function createPassThrough() {
	return new PassThrough();
}

function createFakeChildProcess() {
	return {
		stdin: createPassThrough(),
		stdout: createPassThrough(),
		stderr: createPassThrough(),
		exitCode: null,
		pid: 12345,
		on: mock.fn(),
		removeAllListeners: mock.fn(),
		kill: mock.fn(() => true),
	};
}

function createDefaultMockConnection() {
	return {
		sendRequest: mock.fn(async (method: string) => {
			if (method === "initialize") return { capabilities: {} };
			if (method === "shutdown") return null;
			return null;
		}),
		sendNotification: mock.fn(async () => {}),
		onNotification: mock.fn(),
		onError: mock.fn(),
		listen: mock.fn(),
		dispose: mock.fn(),
	};
}

/**
 * Create a mock LspRuntime for testing.
 * Each call returns a fresh runtime with mock.fn()-backed stubs.
 * The runtime's loadJsonRpc returns a JsonRpcModule wired to the
 * module-level mockConnection, giving per-test control.
 */
function createMockRuntime(): LspRuntime {
	return {
		spawn: mock.fn(() => createFakeChildProcess()),
		execFile: mock.fn((...args: any[]) => {
			// execFile(file, args, options, callback); find the callback
			const cb = [...args].reverse().find((a: any) => typeof a === "function");
			if (cb) cb(null, "", "");
		}),
		existsSync: mock.fn(() => true),
		readFile: mock.fn(async () => "const x = 1;\n"),
		loadJsonRpc: mock.fn(async (): Promise<JsonRpcModule | null> => {
			return {
				StreamMessageReader: class {
					constructor(_stream: unknown) {
						/* noop */
					}
				} as unknown as new (stream: unknown) => unknown,
				StreamMessageWriter: class {
					constructor(_stream: unknown) {
						/* noop */
					}
				} as unknown as new (stream: unknown) => unknown,
				createMessageConnection: mock.fn(() => mockConnection),
			};
		}),
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("auditFileGroup notification error handling", () => {
	beforeEach(() => {
		mockConnection = createDefaultMockConnection();
		setLspRuntime(createMockRuntime());
	});

	afterEach(() => {
		resetLspRuntime();
	});

	it("initialized notification succeeds → continues, opens files, collects diagnostics", async () => {
		// Simulate diagnostics being published after file open.
		// The code uses the star-notification-handler overload:
		//   connection.onNotification((method: string, params: unknown) => { ... })
		mockConnection.onNotification = mock.fn((handler: Function) => {
			setImmediate(() => {
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/test.ts",
					diagnostics: [
						{
							range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
							severity: 1,
							message: "Test diagnostic",
						},
					],
				});
			});
		});

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		assert.strictEqual(result.errors.length, 0, "should have no errors");
		assert.ok(result.diagnostics.length > 0, "should collect diagnostics");
	});

	it("initialized notification rejects (async) → error pushed, early return, no files opened", async () => {
		mockConnection.sendNotification = mock.fn(async (method: string) => {
			if (method === "initialized") throw new Error("connection lost during initialized");
			return undefined;
		});

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		assert.ok(
			result.errors.some((e: string) => e.includes("initialized")),
			"should have error about initialized notification",
		);
		assert.strictEqual(result.diagnostics.length, 0, "should have no diagnostics");
	});

	it("initialized notification throws synchronously (connection closed) → caught by try/catch, early return", async () => {
		mockConnection.sendNotification = mock.fn((method: string) => {
			if (method === "initialized") throw new Error("connection already closed");
			return Promise.resolve();
		});

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		assert.ok(
			result.errors.some((e: string) => e.includes("initialized")),
			"should have error about initialized notification",
		);
		assert.strictEqual(result.diagnostics.length, 0, "should have no diagnostics");
	});

	it("didOpen notification rejects for one file → per-file error pushed, file NOT added to openedUris, loop continues", async () => {
		const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

		let callCount = 0;
		mockConnection.sendNotification = mock.fn(async (method: string) => {
			if (method === "textDocument/didOpen") {
				callCount++;
				if (callCount === 2) throw new Error("connection lost during didOpen");
			}
			return undefined;
		});

		// Simulate diagnostics for successfully opened files only
		mockConnection.onNotification = mock.fn((handler: Function) => {
			setImmediate(() => {
				// Only send diagnostics for files that were opened
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/a.ts",
					diagnostics: [
						{
							range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
							severity: 1,
							message: "Diag A",
						},
					],
				});
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/c.ts",
					diagnostics: [
						{
							range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
							severity: 2,
							message: "Diag C",
						},
					],
				});
			});
		});

		const result = await auditFileGroup(TS_MAPPING, files, "/worktree");

		// Should have an error for the failed didOpen on second file
		assert.ok(
			result.errors.some((e: string) => e.includes("didOpen")),
			"should have error about didOpen",
		);
		// Should still have diagnostics from files that succeeded
		assert.ok(result.diagnostics.length > 0, "should have some diagnostics");
	});

	it("didOpen notification throws synchronously → per-file error pushed, file skipped", async () => {
		const files = ["src/a.ts", "src/b.ts"];

		let callCount = 0;
		mockConnection.sendNotification = mock.fn((method: string) => {
			if (method === "textDocument/didOpen") {
				callCount++;
				if (callCount === 2) throw new Error("sync error during didOpen");
			}
			return Promise.resolve();
		});

		mockConnection.onNotification = mock.fn((handler: Function) => {
			setImmediate(() => {
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/a.ts",
					diagnostics: [
						{
							range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
							severity: 1,
							message: "Diag A",
						},
					],
				});
			});
		});

		const result = await auditFileGroup(TS_MAPPING, files, "/worktree");

		assert.ok(
			result.errors.some((e: string) => e.includes("didOpen")),
			"should have error about didOpen",
		);
		assert.ok(result.diagnostics.length > 0, "should have diagnostics from successful file");
	});

	it("exit notification rejects → caught by .catch(), not in errors array", async () => {
		mockConnection.sendNotification = mock.fn(async (method: string) => {
			if (method === "exit") throw new Error("connection already disposed");
			return undefined;
		});

		// Simulate diagnostics
		mockConnection.onNotification = mock.fn((handler: Function) => {
			setImmediate(() => {
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/test.ts",
					diagnostics: [],
				});
			});
		});

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		// Exit rejection should not leak into errors
		assert.ok(
			!result.errors.some((e: string) => e.includes("exit")),
			"exit rejection should not be in errors",
		);
	});

	it("empty files array → no didOpen calls, polling exits immediately, returns empty diagnostics", async () => {
		const sendNotificationMock = mock.fn(async () => {});
		mockConnection.sendNotification = sendNotificationMock;

		const result = await auditFileGroup(TS_MAPPING, EMPTY_FILES, "/worktree");

		// DidOpen should never be called (check on the mock)
		const didOpenCalls = sendNotificationMock.mock.calls.filter(
			(c: any) => c.arguments[0] === "textDocument/didOpen",
		);
		assert.strictEqual(didOpenCalls.length, 0, "should not call didOpen for empty files");
		assert.strictEqual(result.errors.length, 0, "should have no errors");
		assert.strictEqual(result.diagnostics.length, 0, "should have no diagnostics");
	});

	it("onError handler receives tuple [Error, unknown, number] → destructured correctly, error captured", async () => {
		let registeredHandler: Function | null = null;
		mockConnection.onError = mock.fn((handler: Function) => {
			registeredHandler = handler;
		});

		// Trigger the onError handler during initialize to verify error capture
		mockConnection.sendRequest = mock.fn(async (method: string) => {
			if (method === "initialize") {
				// Fire the onError handler to test tuple destructuring
				if (registeredHandler) {
					registeredHandler([new Error("stream write failed"), undefined, undefined]);
				}
				return { capabilities: {} };
			}
			if (method === "shutdown") return null;
			return null;
		});

		// Simulate diagnostics
		mockConnection.onNotification = mock.fn((handler: Function) => {
			setImmediate(() => {
				handler("textDocument/publishDiagnostics", {
					uri: "file:///worktree/src/test.ts",
					diagnostics: [],
				});
			});
		});

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		assert.ok(
			result.errors.some((e: string) => e.includes("stream write failed")),
			"should capture error from onError handler with tuple destructuring",
		);
	});

	it("setLspRuntime with undefined throws TypeError", () => {
		assert.throws(
			() => (setLspRuntime as any)(undefined),
			/TypeError/,
			"setLspRuntime should throw TypeError when called with undefined",
		);
	});

	it("resetLspRuntime is idempotent — no error when no runtime set", () => {
		// Reset first to ensure clean state
		resetLspRuntime();
		// Then reset again — should not throw
		resetLspRuntime();
		// Should default back to real Node modules (no crash when calling)
	});
});
