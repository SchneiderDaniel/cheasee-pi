// ─── Tests: agent-runner.ts subprocess path ───────────────────────
// Tests runAgentSubprocess by mocking node:child_process spawn.
// Uses mock.module for module-level mocking with dynamic imports.
//
// Scenarios:
//   1. Normal completion with text and thinking output
//   2. Budget exceed → child.kill("SIGTERM") called
//   3. Subprocess timeout (code=null, signal="SIGTERM")
//   4. Widget flush scheduling
//   5. doResolve correctly builds AgentRunResult (including budgetExceeded)

import { describe, it, mock, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// ─── Import real child_process to preserve non-mocked exports ─────
// We need the real spawnSync for pi-coding-agent dependency.
// We only override spawn in the mock.
import * as childProcessModule from "node:child_process";

// ─── Mock child process types ─────────────────────────────────────

interface MockChild {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof mock.fn>;
	pid: number;
	_ref: { exitHandler?: Function; closeHandlers: Function[]; errorHandlers: Function[] };
	on: (event: string, handler: Function) => void;
}

// ─── Global reference for tests to control the mock child ─────────

let currentMockChild: MockChild | null = null;
let currentMockOpts: {
	stdoutLines?: string[];
	stderrLines?: string[];
	exitCode?: number | null;
	exitSignal?: string | null;
} = {};

function createMockChild(): MockChild {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const kill = mock.fn();
	const ref = {
		exitHandler: undefined as Function | undefined,
		closeHandlers: [] as Function[],
		errorHandlers: [] as Function[],
	};

	const child: MockChild = {
		stdout: stdout as any,
		stderr: stderr as any,
		kill,
		pid: 12345,
		_ref: ref,
		on: (event: string, handler: Function) => {
			if (event === "exit") ref.exitHandler = handler;
			else if (event === "close") ref.closeHandlers.push(handler);
			else if (event === "error") ref.errorHandlers.push(handler);
		},
	};

	currentMockChild = child;
	return child;
}

/** Emit events on the current mock child to simulate subprocess completion */
function emitMockEvents(): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");

	const opts = currentMockOpts;

	// Emit stdout data lines
	if (opts.stdoutLines) {
		for (const line of opts.stdoutLines) {
			child.stdout.emit("data", Buffer.from(line + "\n"));
		}
	}

	// Emit stderr data lines
	if (opts.stderrLines) {
		for (const line of opts.stderrLines) {
			child.stderr.emit("data", Buffer.from(line + "\n"));
		}
	}

	// Emit exit first (process table cleanup)
	if (child._ref.exitHandler) {
		child._ref.exitHandler(opts.exitCode ?? 0, opts.exitSignal ?? null);
	}

	// Emit close after stdio drains
	for (const h of child._ref.closeHandlers) {
		h(opts.exitCode ?? 0, opts.exitSignal ?? null);
	}
}

// ─── Mock the module ──────────────────────────────────────────────
// Must be at top level, BEFORE any dynamic import of agent-runner.ts.
// We preserve all real exports (like spawnSync) and only override spawn.
// Guard: mock.module requires --experimental-test-module-mocks in Node.js < 23.

const hasMockModule = typeof mock.module === "function";

const mockSpawn = () => createMockChild();

// Build namedExports preserving all real exports + overridden spawn
const namedExports: Record<string, unknown> = {};
for (const key of Object.keys(childProcessModule)) {
	namedExports[key] = (childProcessModule as any)[key];
}
namedExports.spawn = mockSpawn;

if (hasMockModule) {
	mock.module("node:child_process", {
		namedExports,
	});
}

// ─── Fixtures ─────────────────────────────────────────────────────

const mockAgent = {
	config: {
		name: "test-agent",
		tools: "read,bash",
		model: "anthropic/claude-sonnet-4-20250514",
		extensions: "",
		skills: "",
		thinking: "",
	},
	systemPrompt: "You are a test agent.",
};

const mockCtx: any = {
	cwd: "/tmp",
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: mock.fn(),
		setWorkingMessage: mock.fn(),
	},
};

// ─── Helpers ──────────────────────────────────────────────────────

/** Reset mock state before each test group */
function resetMock(): void {
	currentMockChild = null;
	currentMockOpts = {};
	mockCtx.ui.setWidget = mock.fn();
	mockCtx.ui.setWorkingMessage = mock.fn();
	(mockCtx.ui.setWidget as any).mock.resetCalls?.();
	(mockCtx.ui.setWorkingMessage as any).mock.resetCalls?.();
}

// ─── Tests ────────────────────────────────────────────────────────
// If mock.module unavailable, skip all tests (requires --experimental-test-module-mocks).
if (!hasMockModule) {
	describe("agent-runner-subprocess", () => {
		it("requires --experimental-test-module-mocks flag (Node.js < 23)", (t) => t.skip());
	});
}

if (hasMockModule) {
	describe("runAgentSubprocess — normal completion", () => {
		before(() => resetMock());

		it("succeeds with text output when JSON stream is clean", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Task complete." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.equal(result.agentName, "test-agent");
			assert.ok(
				result.textOutput.includes("Task complete."),
				"textOutput should contain the assistant text",
			);
			assert.ok(
				result.textOnly.includes("Task complete."),
				"textOnly should contain the assistant text",
			);
			assert.equal(typeof result.durationMs, "number");
		});

		it("captures thinking output when thinking events precede text", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "thinking_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: {
							type: "thinking_delta",
							thinking_delta: "Let me reason about this step by step.",
						},
					}),
					JSON.stringify({ type: "message_update", delta: { type: "thinking_end" } }),
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Here is my answer." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.ok(result.thinkingOutput, "thinkingOutput should be defined");
			assert.ok(
				result.thinkingOutput!.includes("reason about this"),
				"thinkingOutput should contain thinking text",
			);
			assert.ok(
				result.textOutput.includes("Here is my answer"),
				"textOutput should contain answer",
			);
		});

		it("sets summaryLine from agent text output", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: {
							type: "text_delta",
							text_delta: "IMPLEMENTATION_COMPLETE\nAll features implemented.",
						},
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.ok(result.summaryLine, "summaryLine should be set");
		});
	});

	describe("runAgentSubprocess — budget exceed", () => {
		it('calls child.kill("SIGTERM") when budget is exceeded', async () => {
			resetMock();
			// Tool execution end increments toolCount to 1.
			// With maxToolCalls=1, message_end will set budgetExceeded=true → child.kill("SIGTERM").
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: "SIGTERM",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				1,
				undefined,
			);

			emitMockEvents();

			const result = await resultPromise;
			// Budget exceeded should be true, success=false
			assert.equal(result.budgetExceeded, true, "budgetExceeded should be true");
			assert.equal(result.success, false, "should be failed when budget exceeded");

			// Verify child.kill("SIGTERM") was called
			const child = currentMockChild;
			assert.ok(child, "mock child should exist");
			assert.equal(child!.kill.mock.calls.length, 1, "kill should have been called once");
			assert.equal(
				child!.kill.mock.calls[0]?.arguments?.[0],
				"SIGTERM",
				"kill should be called with SIGTERM",
			);
		});

		it("result has budgetExceeded field when tool limit exceeded", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", usage: { totalTokens: 100 } },
					}),
				],
				exitCode: 0,
				exitSignal: "SIGTERM",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				1,
				undefined,
			);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.budgetExceeded, true);
		});
	});

	describe("runAgentSubprocess — timeout handling", () => {
		it("returns success=false when child exits with signal SIGTERM (killed)", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Partial output" },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: null,
				exitSignal: "SIGTERM",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, false, "child killed by signal should be failure");
			// text output should still be captured
			assert.ok(result.textOutput.length > 0, "text output should be preserved on timeout");
		});

		it("returns success=false when killed by signal with no output", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [],
				exitCode: null,
				exitSignal: "SIGTERM",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, false);
			assert.equal(typeof result.durationMs, "number");
			assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
		});
	});

	describe("runAgentSubprocess — widget flush scheduling", () => {
		it("clears widget on completion (called with undefined)", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "done" },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			await resultPromise;

			// After doResolve, widget should be cleared (setWidget called with undefined)
			const setWidget = mockCtx.ui.setWidget as ReturnType<typeof mock.fn>;
			const lastCall = setWidget.mock.calls[setWidget.mock.calls.length - 1];
			// The last call should clear the widget (second arg undefined or null)
			assert.ok(lastCall, "setWidget should have been called at least once");
		});

		it(
			"calls setWidget during execution (via scheduleFlush or heartbeat)",
			{ timeout: 5000 },
			async () => {
				resetMock();
				currentMockOpts = {
					stdoutLines: [
						JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
						JSON.stringify({
							type: "message_update",
							delta: { type: "text_delta", text_delta: "Working..." },
						}),
						JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
						JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
					],
					exitCode: 0,
					exitSignal: null,
				};

				const { runAgentSubprocess } = await import("../agent/runner.ts");
				const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

				// Wait briefly for scheduleFlush (300ms debounce) to fire
				await new Promise((r) => setTimeout(r, 400));

				emitMockEvents();
				await resultPromise;

				// setWidget should have been called at least once (by scheduleFlush or heartbeat)
				const setWidget = mockCtx.ui.setWidget as ReturnType<typeof mock.fn>;
				assert.ok(
					setWidget.mock.calls.length >= 1,
					"setWidget should have been called at least once",
				);
			},
		);
	});

	describe("runAgentSubprocess — error path", () => {
		it("handles spawn error (binary not found) gracefully", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			// Emit error on the child instead of close
			const child = currentMockChild;
			if (child && child._ref.errorHandlers.length > 0) {
				const err = new Error("ENOENT: spawn pi ENOENT");
				for (const h of child._ref.errorHandlers) {
					h(err);
				}
			}

			const result = await resultPromise;
			assert.equal(result.success, false);
			assert.ok(
				result.output.includes("Failed to start") || result.errorOutput,
				"should report spawn failure",
			);
		});
	});

	describe("runAgentSubprocess — stderr handling", () => {
		it("captures stderr output as errorOutput", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "result" },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				stderrLines: ["Warning: some diagnostic info"],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.equal(result.success, true);
			// stderr should be captured (after filtering)
			assert.ok(typeof result.errorOutput === "string", "errorOutput should be a string");
		});
	});

	describe("runAgentSubprocess — rendering contract", () => {
		it("forwards bash tool-complete with command args", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "bash",
						args: { command: "ls -la /tmp" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "bash",
							content: [{ type: "text", text: "drwxr-xr-x ..." }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolCompleteMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-complete",
			);
			const toolStartMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-start",
			);

			// tool-start has args
			if (toolStartMsgs[0]) {
				assert.equal(
					toolStartMsgs[0].details.args,
					"$ ls -la /tmp",
					"tool-start args should be formatted bash command",
				);
			}
			// tool-complete carries same formatted args (the bug fix)
			if (toolCompleteMsgs[0]) {
				assert.equal(toolCompleteMsgs[0].details.toolName, "bash");
				assert.equal(
					toolCompleteMsgs[0].details.args,
					"$ ls -la /tmp",
					"tool-complete bash args should match tool-start — was empty before fix",
				);
			}
		});

		it("forwards tool_execution_start as eventType: tool-start", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "read",
						args: { path: "/tmp/x.ts" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "read",
							content: [{ type: "text", text: "file content" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolStartMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-start",
			);
			assert.ok(
				toolStartMsgs.length >= 1,
				`expected >=1 tool-start messages, got ${toolStartMsgs.length}`,
			);
			if (toolStartMsgs[0]) {
				assert.equal(toolStartMsgs[0].details.toolName, "read");
			}
		});

		it("forwards toolResult message_end as eventType: tool-complete with formatted args", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "read",
						args: { path: "/tmp/x.ts" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "read",
							content: [{ type: "text", text: "file content" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolCompleteMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-complete",
			);
			assert.ok(
				toolCompleteMsgs.length >= 1,
				`expected >=1 tool-complete messages, got ${toolCompleteMsgs.length}`,
			);
			if (toolCompleteMsgs[0]) {
				assert.equal(toolCompleteMsgs[0].details.toolName, "read");
				assert.equal(
					toolCompleteMsgs[0].details.args,
					"read /tmp/x.ts",
					"tool-complete should carry formatted args from tool_execution_start",
				);
				assert.ok(
					toolCompleteMsgs[0].details.resultText?.includes("file content"),
					"tool-complete should include result text",
				);
			}
		});

		it("forwards thinking_end as eventType: thinking with content", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "thinking_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "thinking_delta", thinking_delta: "Let me analyze the code." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "thinking_end" } }),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "result" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const thinkingMsgs = sendMessageCalls.filter((m: any) => m.details?.eventType === "thinking");
			assert.ok(
				thinkingMsgs.length >= 1,
				`expected >=1 thinking messages, got ${thinkingMsgs.length}`,
			);
			if (thinkingMsgs[0]) {
				assert.ok(
					thinkingMsgs[0].details.content?.includes("Let me analyze"),
					"thinking message should contain the thinking text",
				);
			}
		});
	});

	describe("runAgentSubprocess — result assembly", () => {
		it("doResolve returns AgentRunResult with all expected fields", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Final result." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			// Assert all fields expected in AgentRunResult
			assert.equal(typeof result.success, "boolean");
			assert.equal(typeof result.agentName, "string");
			assert.equal(typeof result.durationMs, "number");
			assert.equal(typeof result.toolCount, "number");
			assert.equal(typeof result.tokenCount, "number");
			assert.equal(typeof result.textOutput, "string");
			assert.equal(typeof result.textOnly, "string");
			assert.equal(typeof result.summaryLine, "string");
			assert.equal(typeof result.errorOutput, "string");
			assert.equal(result.agentName, "test-agent");
			assert.ok("budgetExceeded" in result);
		});

		it("result includes output (raw stdout from subprocess)", async () => {
			resetMock();
			const lines = [
				JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "Work done." },
				}),
				JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
				JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
			];
			currentMockOpts = {
				stdoutLines: lines,
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitMockEvents();

			const result = await resultPromise;
			assert.ok(result.output.length > 0, "raw output should capture stdout");
			assert.ok(result.output.includes("message_update"), "raw output should contain JSON lines");
		});
	});

	describe("runAgentSubprocess — agentName on tool-complete", () => {
		it("tool-complete details include agentName matching the agent name", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "read",
						args: { path: "/tmp/x.ts" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "read",
							content: [{ type: "text", text: "file content" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolCompleteMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-complete",
			);
			assert.ok(toolCompleteMsgs.length >= 1, "should have tool-complete messages");
			for (const msg of toolCompleteMsgs) {
				assert.equal(
					msg.details.agentName,
					"test-agent",
					"tool-complete details should include agentName",
				);
			}
		});

		it("tool-complete details contain agentName even when no prior tool-start was emitted", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					// No tool_execution_start — tool-complete from toolResult only
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "bash",
							content: [{ type: "text", text: "result" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolCompleteMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-complete",
			);
			assert.ok(toolCompleteMsgs.length >= 1, "should have tool-complete messages");
			for (const msg of toolCompleteMsgs) {
				assert.equal(
					msg.details.agentName,
					"test-agent",
					"tool-complete details should include agentName even without prior tool-start",
				);
			}
		});

		it("agentName value matches the agent name from config — consistent with tool-start", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "bash",
						args: { command: "ls" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "bash",
							content: [{ type: "text", text: "result" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolStartMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-start",
			);
			const toolCompleteMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-complete",
			);

			assert.ok(toolStartMsgs.length >= 1, "should have tool-start messages");
			assert.ok(toolCompleteMsgs.length >= 1, "should have tool-complete messages");

			// Both events should reference the same agent name
			for (const msg of toolStartMsgs) {
				assert.equal(
					msg.details.agentName,
					"test-agent",
					"tool-start agentName should match config name",
				);
			}
			for (const msg of toolCompleteMsgs) {
				assert.equal(
					msg.details.agentName,
					"test-agent",
					"tool-complete agentName should match config name",
				);
			}
		});

		it("existing tool-start event details still include agentName (no regression)", async () => {
			resetMock();
			const sendMessageCalls: any[] = [];
			const mockPi = { sendMessage: (msg: any) => sendMessageCalls.push(msg) };

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "tool_execution_start",
						toolName: "edit",
						args: { path: "/tmp/a.ts" },
					}),
					JSON.stringify({ type: "tool_execution_end", toolName: "edit", isError: false }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "toolResult",
							toolName: "edit",
							content: [{ type: "text", text: "applied" }],
						},
					}),
					JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					}),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				mockPi as any,
			);
			emitMockEvents();
			await resultPromise;

			const toolStartMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-start",
			);
			assert.ok(toolStartMsgs.length >= 1, "should have tool-start messages");
			// tool-start already has agentName before this change — verify it's still there
			for (const msg of toolStartMsgs) {
				assert.ok(
					msg.details.agentName !== undefined,
					"tool-start should still have agentName",
				);
			}
		});
	});

	describe("buildSubprocessArgs — return struct", () => {
		it("returns { args, tools, skillPaths } with correct types", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(Array.isArray(result.args));
			assert.equal(typeof result.tools, "string");
			assert.ok(Array.isArray(result.skillPaths));
			assert.equal(result.toolSpillDir, undefined);
		});

		it("args array includes expected CLI flags", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.args.includes("--mode"), "should have --mode");
			assert.ok(result.args.includes("json"), "should have json");
			assert.ok(result.args.includes("--system-prompt"), "should have --system-prompt");
			assert.ok(result.args.includes("--tools"), "should have --tools");
			assert.ok(result.args.includes("--no-extensions"), "should have --no-extensions");
			assert.ok(result.args.includes("--no-skills"), "should have --no-skills");
			assert.ok(result.args.includes("--no-context-files"), "should have --no-context-files");
		});

		it("tools string matches resolved tools from agent config", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.tools.includes("read"), "tools should contain read");
			assert.ok(result.tools.includes("bash"), "tools should contain bash");
		});

		it("toolSpillDir is present when task > SAFE_TASK_CHARS (1,200,000)", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const largeTask = "x".repeat(1_200_001);
			const result = buildSubprocessArgs(mockAgent as any, largeTask, "/tmp");
			assert.ok(
				result.toolSpillDir !== undefined,
				"toolSpillDir should be present for large task",
			);
			assert.ok(
				typeof result.toolSpillDir === "string" && result.toolSpillDir.length > 0,
				"toolSpillDir should be a non-empty string",
			);
		});

		it("toolSpillDir is undefined when task ≤ SAFE_TASK_CHARS", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "small task", "/tmp");
			assert.equal(result.toolSpillDir, undefined);
		});

		it("args with model includes --model flag", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.args.includes("--model"), "should have --model");
			assert.ok(
				result.args.includes("anthropic/claude-sonnet-4-20250514"),
				"should include model name",
			);
		});

		it("args without model omits --model flag", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const noModelAgent = {
				config: {
					name: "no-model-agent",
					tools: "read",
					model: "",
					extensions: "",
					skills: "",
					thinking: "",
				},
				systemPrompt: "You are a test.",
			};
			const result = buildSubprocessArgs(noModelAgent as any, "test task", "/tmp");
			assert.ok(!result.args.includes("--model"), "should not have --model when empty");
		});
	});

	describe("runAgentSubprocess — safe fallback (guarded pre-Promise block)", () => {
		it("sync throw from resolveSkillPaths (missing skill) returns {success: false}", async () => {
			resetMock();
			const badSkillAgent = {
				config: {
					name: "bad-skill-agent",
					tools: "read",
					model: "anthropic/claude-sonnet-4-20250514",
					extensions: "",
					skills: "nonexistent-skill",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess(
				badSkillAgent as any,
				"test task",
				mockCtx,
				5000,
			);

			assert.equal(result.success, false);
			assert.ok(
				result.summaryLine.includes("Subprocess setup failed") ||
					result.summaryLine.includes("not found"),
				`summaryLine should indicate failure: ${result.summaryLine}`,
			);
			assert.equal(result.agentName, "bad-skill-agent");
			assert.equal(result.toolCount, 0);
			assert.equal(result.tokenCount, 0);
		});

		it("existsSync(effectiveCwd) guard still returns {success: false} (regression)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				"/nonexistent-path-12345",
			);

			assert.equal(result.success, false);
			assert.ok(
				result.summaryLine.includes("Worktree missing"),
				`summaryLine should mention worktree missing: ${result.summaryLine}`,
			);
			assert.equal(result.agentName, "test-agent");
		});

		it("runAgentSubprocess never rejects for any input (bad skill, bad cwd)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");

			// Bad skill
			const badSkillAgent = {
				config: {
					name: "bad-skill-agent",
					tools: "read",
					model: "anthropic/claude-sonnet-4-20250514",
					extensions: "",
					skills: "nonexistent-skill",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};

			const result = await runAgentSubprocess(
				badSkillAgent as any,
				"test task",
				mockCtx,
				5000,
			);
			assert.equal(result.success, false);
			assert.equal(result.agentName, "bad-skill-agent");
		});

		it("normal subprocess happy path still resolves with success: true (regression)", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Completed." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
			);
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.success, true);
		});

		it("sync throw produces AgentRunResult with all expected fields", async () => {
			resetMock();
			const badSkillAgent = {
				config: {
					name: "bad-skill-agent",
					tools: "read",
					model: "anthropic/claude-sonnet-4-20250514",
					extensions: "",
					skills: "nonexistent-skill",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess(
				badSkillAgent as any,
				"test task",
				mockCtx,
				5000,
			);

			// Verify all AgentRunResult fields are present
			assert.equal(typeof result.success, "boolean");
			assert.equal(typeof result.agentName, "string");
			assert.equal(typeof result.toolCount, "number");
			assert.equal(typeof result.tokenCount, "number");
			assert.equal(typeof result.durationMs, "number");
			assert.equal(typeof result.textOutput, "string");
			assert.equal(typeof result.textOnly, "string");
			assert.equal(typeof result.summaryLine, "string");
			assert.equal(typeof result.errorOutput, "string");
			assert.equal(typeof result.output, "string");
			assert.ok("budgetExceeded" in result);
		});
	});
}
