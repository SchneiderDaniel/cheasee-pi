import { describe, it, mock } from "node:test";

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

if (hasMockModule) {
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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				pi: mockPi as any,
			});
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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				pi: mockPi as any,
			});
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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				pi: mockPi as any,
			});
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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				pi: mockPi as any,
			});
			emitMockEvents();
			await resultPromise;

			const toolStartMsgs = sendMessageCalls.filter(
				(m: any) => m.details?.eventType === "tool-start",
			);
			assert.ok(toolStartMsgs.length >= 1, "should have tool-start messages");
			// tool-start already has agentName before this change — verify it's still there
			for (const msg of toolStartMsgs) {
				assert.ok(msg.details.agentName !== undefined, "tool-start should still have agentName");
			}
		});
	});
}
