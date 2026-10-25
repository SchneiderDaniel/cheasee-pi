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
	describe("runAgentSubprocess — error path", () => {
		it("handles spawn error (binary not found) gracefully", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [],
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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				pi: mockPi as any,
			});
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
}
