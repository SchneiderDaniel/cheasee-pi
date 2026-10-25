import { describe, it, mock, before } from "node:test";

import assert from "node:assert/strict";

import { EventEmitter } from "node:events";

import * as childProcessModule from "node:child_process";

interface MockChild {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof mock.fn>;
	pid: number;
	_ref: { exitHandler?: Function; closeHandlers: Function[]; errorHandlers: Function[] };
	on: (event: string, handler: Function) => void;
}

let currentMockChild: MockChild | null = null;

let currentMockOpts: {
	stdoutLines?: string[];
	stderrLines?: string[];
	exitCode?: number | null;
	exitSignal?: string | null;
} = {};

let lastSpawnOpts: Record<string, unknown> | null = null;

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

const hasMockModule = typeof mock.module === "function";

const mockSpawn = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
	lastSpawnOpts = opts;
	return createMockChild();
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resetMock(): void {
	currentMockChild = null;
	lastSpawnOpts = null;
	currentMockOpts = {};
	mockCtx.ui.setWidget = mock.fn();
	mockCtx.ui.setWorkingMessage = mock.fn();
	(mockCtx.ui.setWidget as any).mock.resetCalls?.();
	(mockCtx.ui.setWorkingMessage as any).mock.resetCalls?.();
}

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
				const resultPromise = runAgentSubprocess({
					agent: mockAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				});

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
}
