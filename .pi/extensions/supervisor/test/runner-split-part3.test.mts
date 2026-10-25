import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import { join, dirname } from "node:path";

import { fileURLToPath } from "node:url";

import { EventEmitter } from "node:events";

import type { AgentRunState } from "../config/types.ts";

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const RUNNER_DIR = join(__dirname, "../agent/runner");

const SHIM_FILE = join(__dirname, "../agent/runner.ts");

const MODULES = [
	"args.ts",
	"spawn.ts",
	"stream.ts",
	"budget.ts",
	"deadline.ts",
	"cleanup.ts",
	"ui.ts",
	"event-loop.ts",
	"spawned-run.ts",
	"index.ts",
];

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

const hasMockModule = typeof mock.module === "function";

const spawnCalls: unknown[][] = [];

if (hasMockModule) {
	const namedExports: Record<string, unknown> = {};
	for (const key of Object.keys(childProcessModule)) {
		namedExports[key] = (childProcessModule as any)[key];
	}
	namedExports["spawn"] = (...args: unknown[]) => {
		spawnCalls.push(args);
		return createMockChild();
	};
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
		setStatus: mock.fn(),
		setWidget: mock.fn(),
		setWorkingMessage: mock.fn(),
	},
};

function resetMock(): void {
	currentMockChild = null;
	mockCtx.ui.setWidget = mock.fn();
	mockCtx.ui.setWorkingMessage = mock.fn();
	mockCtx.ui.setStatus = mock.fn();
}

function emitStdoutLines(lines: string[]): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");
	for (const line of lines) child.stdout.emit("data", Buffer.from(line + "\n"));
}

function emitStdoutRaw(chunk: string): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");
	child.stdout.emit("data", Buffer.from(chunk));
}

function emitStderrLines(lines: string[]): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");
	for (const line of lines) child.stderr.emit("data", Buffer.from(line + "\n"));
}

function emitExit(code: number | null, signal: string | null): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");
	if (child._ref.exitHandler) child._ref.exitHandler(code, signal);
}

function emitClose(code: number | null, signal: string | null): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");
	for (const h of child._ref.closeHandlers) h(code, signal);
}

function emitMockEvents(opts: {
	stdoutLines?: string[];
	stderrLines?: string[];
	exitCode?: number | null;
	exitSignal?: string | null;
}): void {
	emitStdoutLines(opts.stdoutLines ?? []);
	emitStderrLines(opts.stderrLines ?? []);
	emitExit(opts.exitCode ?? 0, opts.exitSignal ?? null);
	emitClose(opts.exitCode ?? 0, opts.exitSignal ?? null);
}

function nbnc(source: string): number {
	return source.split("\n").filter((line) => {
		const t = line.trim();
		if (t === "") return false;
		if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
		return true;
	}).length;
}

function functionSpan(source: string, fnName: string): number | null {
	const lines = source.split("\n");
	const startIdx = lines.findIndex((l) => new RegExp(`function\\s+${fnName}\\s*\\(`).test(l));
	if (startIdx === -1) return null;
	let depth = 0;
	for (let i = startIdx; i < lines.length; i++) {
		for (const ch of lines[i]!) {
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return i - startIdx + 1;
			}
		}
	}
	return null;
}

function maxFunctionSpan(source: string): number {
	const lines = source.split("\n");
	let maxSpan = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const isFnStart =
			/function\s+[\w]*\s*\(/.test(line) ||
			/^\s*(?:export\s+)?const\s+[\w]+\s*=\s*\([^)]*\)\s*=>/.test(line);
		if (!isFnStart) continue;
		let depth = 0;
		let started = false;
		for (let j = i; j < lines.length; j++) {
			for (const ch of lines[j]!) {
				if (ch === "{") {
					depth++;
					started = true;
				} else if (ch === "}") depth--;
			}
			if (started && depth === 0) {
				maxSpan = Math.max(maxSpan, j - i + 1);
				break;
			}
		}
	}
	return maxSpan;
}

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		toolCalls: [],
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

if (hasMockModule) {
	describe("runner/cleanup.ts — stateResultFields (state→fields mapping)", () => {
		const baseArgs = (
			state: AgentRunState,
			over?: Partial<Parameters<typeof import("../agent/runner/cleanup.ts").stateResultFields>[0]>,
		) => ({
			state,
			agentName: "test-agent",
			durationMs: 1234,
			textOutput: "Task complete.",
			success: true,
			...over,
		});

		it("omits the four caller-injected fields", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			const fields = stateResultFields(baseArgs(createState())) as Record<string, unknown>;
			for (const key of ["output", "success", "errorOutput", "textOutput"]) {
				assert.ok(!(key in fields), `${key} must be injected by the caller, not the builder`);
			}
		});

		it("thinkingLevel passes through (present or undefined)", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(
				stateResultFields(baseArgs(createState({ thinkingLevel: "medium" }))).thinkingLevel,
				"medium",
			);
			assert.equal(stateResultFields(baseArgs(createState())).thinkingLevel, undefined);
		});

		it("failedToolCount: undefined → undefined; 0 → 0 (boundary); 3 → 3", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(stateResultFields(baseArgs(createState())).failedToolCount, undefined);
			assert.equal(
				stateResultFields(baseArgs(createState({ failedToolCount: 0 }))).failedToolCount,
				0,
			);
			assert.equal(
				stateResultFields(baseArgs(createState({ failedToolCount: 3 }))).failedToolCount,
				3,
			);
		});

		it("nestedCalls deep-equals nestedCallsFromState; nestedErrors passes through", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			const { nestedCallsFromState } = await import("../agent/state-helpers.ts");
			const state = createState({
				nestedCalls: [{ name: "read", status: "ok" }] as AgentRunState["nestedCalls"],
				nestedErrorCount: 2,
			});
			const fields = stateResultFields(baseArgs(state));
			assert.deepEqual(fields.nestedCalls, nestedCallsFromState(state));
			assert.equal(fields.nestedErrors, 2);
			assert.equal(stateResultFields(baseArgs(createState())).nestedErrors, undefined);
		});

		it("budgetExceeded: false → undefined; true → true", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(stateResultFields(baseArgs(createState())).budgetExceeded, undefined);
			assert.equal(
				stateResultFields(baseArgs(createState({ budgetExceeded: true }))).budgetExceeded,
				true,
			);
		});

		it("killReason ternary: timeout > budget > undefined", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(
				stateResultFields(baseArgs(createState({ budgetExceeded: true }), { timedOut: true }))
					.killReason,
				"timeout",
			);
			assert.equal(
				stateResultFields(baseArgs(createState({ budgetExceeded: true }), { timedOut: false }))
					.killReason,
				"budget",
			);
			assert.equal(stateResultFields(baseArgs(createState())).killReason, undefined);
		});

		it("timedOut: true → true; false/omitted → undefined", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(stateResultFields(baseArgs(createState(), { timedOut: true })).timedOut, true);
			assert.equal(
				stateResultFields(baseArgs(createState(), { timedOut: false })).timedOut,
				undefined,
			);
			assert.equal(stateResultFields(baseArgs(createState())).timedOut, undefined);
		});

		it("configuredTimeoutMs only when timedOut and value present", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(
				stateResultFields(baseArgs(createState(), { timedOut: true, configuredTimeoutMs: 5000 }))
					.configuredTimeoutMs,
				5000,
			);
			assert.equal(
				stateResultFields(baseArgs(createState(), { timedOut: true })).configuredTimeoutMs,
				undefined,
			);
			assert.equal(
				stateResultFields(baseArgs(createState(), { timedOut: false, configuredTimeoutMs: 5000 }))
					.configuredTimeoutMs,
				undefined,
			);
		});

		it("thinkingOutput joins lines with a blank line; empty → undefined", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			assert.equal(
				stateResultFields(baseArgs(createState({ thinkingOutputLines: ["a", "b"] })))
					.thinkingOutput,
				"a\n\nb",
			);
			assert.equal(stateResultFields(baseArgs(createState())).thinkingOutput, undefined);
		});

		it("toolCalls is the state reference; textOnly trims joined text lines", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			const state = createState({ toolCalls: ["read", "write"], textOutputLines: ["  hi  "] });
			const fields = stateResultFields(baseArgs(state));
			assert.equal(fields.toolCalls, state.toolCalls);
			assert.equal(fields.textOnly, "hi");
		});

		it("summaryLine derives from the passed textOutput/success/agentName", async () => {
			const { stateResultFields } = await import("../agent/runner/cleanup.ts");
			const fields = stateResultFields(
				baseArgs(createState({ textOutputLines: ["ignored"] }), {
					textOutput: "Did the thing.",
				}),
			);
			assert.equal(fields.summaryLine, "Did the thing.");
		});
	});
	describe("runner/ui.ts — widget cadence", () => {
		it("300ms debounce fires setWidget during execution", async () => {
			resetMock();
			const { createWidgetFlusher } = await import("../agent/runner/ui.ts");
			const state = createState();
			const flusher = createWidgetFlusher({
				ctx: mockCtx,
				widgetId: "agent-test-agent",
				agentName: "test-agent",
				model: "m",
				state,
			});
			flusher.scheduleFlush();
			await new Promise((r) => setTimeout(r, 400));
			const setWidget = mockCtx.ui.setWidget as ReturnType<typeof mock.fn>;
			assert.ok(setWidget.mock.calls.length >= 1, "debounced flush rendered the widget");
			flusher.dispose();
			flusher.dispose(); // idempotent — no double-clear, no throw
		});

		it("clears widget + working message + status on completion and on spawn error", async () => {
			// completion path
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const okPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents({
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
			});
			await okPromise;
			const setWidget = mockCtx.ui.setWidget as ReturnType<typeof mock.fn>;
			const lastWidget = setWidget.mock.calls[setWidget.mock.calls.length - 1];
			assert.ok(lastWidget, "setWidget called at least once");
			assert.equal(lastWidget?.arguments?.[1], undefined, "widget cleared on completion");

			// spawn-error path
			resetMock();
			const errPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			for (const h of currentMockChild!._ref.errorHandlers) {
				h(new Error("ENOENT"));
			}
			await errPromise;
			const setWidget2 = mockCtx.ui.setWidget as ReturnType<typeof mock.fn>;
			const last2 = setWidget2.mock.calls[setWidget2.mock.calls.length - 1];
			assert.equal(last2?.arguments?.[1], undefined, "widget cleared on spawn error");
			const setWorking = mockCtx.ui.setWorkingMessage as ReturnType<typeof mock.fn>;
			assert.ok(
				setWorking.mock.calls.some((c: any) => c.arguments?.[0] === undefined),
				"working message cleared on spawn error",
			);
		});
	});

	describe("runSpawnedProcess — argv rejection maps to a failure result", () => {
		it("invalid argv resolves success:false instead of rejecting", async () => {
			resetMock();
			const { runSpawnedProcess } = await import("../agent/runner/spawned-run.ts");
			const { getDebugLogger } = await import("../lib/debug.ts");
			spawnCalls.length = 0;

			const result = await runSpawnedProcess({
				args: ["bad\0arg"],
				effectiveCwd: "/tmp",
				sandboxEnv: {},
				ctx: mockCtx,
				widgetId: "agent-test-agent",
				agentName: "test-agent",
				model: "",
				state: createState(),
				timeoutMs: null,
				remainingMs: null,
				killGraceSec: undefined,
				startedAt: Date.now(),
				log: getDebugLogger(),
			});

			assert.strictEqual(result.success, false, "the rejection must not escape the contract");
			assert.strictEqual(spawnCalls.length, 0, "no child may be spawned");
			assert.ok(result.output.includes("Failed to start pi:"));
		});
	});
}
