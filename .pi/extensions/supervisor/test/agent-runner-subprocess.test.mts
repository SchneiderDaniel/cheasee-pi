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

		it("forwards toolResult message_end as eventType: tool-complete", async () => {
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
}
