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

if (hasMockModule) {
	const namedExports: Record<string, unknown> = {};
	for (const key of Object.keys(childProcessModule)) {
		namedExports[key] = (childProcessModule as any)[key];
	}
	namedExports["spawn"] = () => createMockChild();
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
	describe("runner/budget.ts — kill policy", () => {
		it("multiple budget-exceeding events → exactly one SIGTERM", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

			emitMockEvents({
				stdoutLines: [
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: "SIGTERM",
			});

			const result = await resultPromise;
			assert.equal(result.budgetExceeded, true);
			const child = currentMockChild!;
			assert.equal(
				child.kill.mock.calls.length,
				1,
				"kill called exactly once despite repeated budget events",
			);
			assert.equal(child.kill.mock.calls[0]?.arguments?.[0], "SIGTERM");
		});

		it("budgetExceeded event after 'exit' → NO kill (childExited guard)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

			emitStdoutLines([
				JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
				JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
			]);
			emitExit(0, null); // childExited = true
			// budget-exceeding event arrives AFTER exit
			emitStdoutLines([JSON.stringify({ type: "message_end", message: { role: "assistant" } })]);
			emitClose(0, null);

			const result = await resultPromise;
			assert.equal(result.budgetExceeded, true);
			assert.equal(currentMockChild!.kill.mock.calls.length, 0, "no kill after childExited");
		});

		it("classifyKillReason uses state.budgetExceeded, not signal", async () => {
			const { classifyKillReason, maybeKillOnBudgetExceeded } =
				await import("../agent/runner/budget.ts");
			assert.equal(classifyKillReason(createState({ budgetExceeded: true })), "budget");
			assert.equal(classifyKillReason(createState({ budgetExceeded: false })), "timeout");

			// maybeKillOnBudgetExceeded: guards on !childExited, idempotent via handle.kill
			let killedWith: string | null = null;
			const fakeHandle = {
				childExited: false,
				kill: (sig: string) => {
					killedWith = sig;
				},
			} as any;
			maybeKillOnBudgetExceeded(createState({ budgetExceeded: true }), fakeHandle);
			assert.equal(killedWith, "SIGTERM");
			fakeHandle.childExited = true;
			maybeKillOnBudgetExceeded(createState({ budgetExceeded: true }), fakeHandle);
			assert.equal(killedWith, "SIGTERM", "no second kill after childExited");
		});
	});
	describe("runner/cleanup.ts — result assembly", () => {
		it("byte-for-byte corpus: rawOutput/textOutput/errorOutput/summaryLine", async () => {
			resetMock();
			const stdoutLines = [
				JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "Task complete." },
				}),
				JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
				JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
			];
			const stderrLines = ["Warning: some diagnostic info"];

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents({ stdoutLines, stderrLines, exitCode: 0, exitSignal: null });

			const result = await resultPromise;
			// output = rawStdout + "\n[STDERR]\n" + stderr — event stream byte-for-byte
			const expectedRaw =
				stdoutLines.map((l) => l + "\n").join("") +
				"\n[STDERR]\n" +
				stderrLines.map((l) => l + "\n").join("");
			assert.equal(result.output, expectedRaw, "rawOutput bytes unchanged");
			assert.equal(result.textOutput, "Task complete.");
			assert.equal(result.textOnly, "Task complete.");
			assert.equal(result.errorOutput, "Warning: some diagnostic info");
			assert.equal(result.summaryLine, "Task complete.");
			assert.equal(result.success, true);
		});

		it("budget-kill corpus: label bytes preserved, textOutput unchanged", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

			emitMockEvents({
				stdoutLines: [
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: "SIGTERM",
			});

			const result = await resultPromise;
			assert.equal(result.budgetExceeded, true);
			assert.equal(result.success, false);
			assert.equal(
				result.textOutput,
				"read ...\n✓ read",
				"textOutput keeps pre-kill content (no relabeling leaked in)",
			);
		});

		it("assembleResult pushes the exact [Timeout: …] label to fullLog", async () => {
			const { assembleResult } = await import("../agent/runner/cleanup.ts");
			const state = createState();
			assembleResult({
				state,
				agentName: "test-agent",
				startedAt: Date.now() - 5_000,
				rawStdout: "",
				stderr: "",
				code: null,
				signal: "SIGTERM",
			});
			assert.equal(state.fullLog.length, 1);
			assert.match(
				state.fullLog[0]!,
				/^\[Timeout: test-agent killed by SIGTERM after [0-9ms ]+\]$/,
				`label bytes preserved: ${state.fullLog[0]}`,
			);
		});

		it("failResult shared shape for setup/existsSync/spawn-error paths", async () => {
			resetMock();
			const { failResult } = await import("../agent/runner/cleanup.ts");
			const r = failResult({
				agentName: "test-agent",
				startedAt: Date.now(),
				errorMessage: "boom",
				summaryLine: "s",
				output: "o",
			});
			assert.equal(r.success, false);
			assert.equal(r.output, "o");
			assert.equal(r.errorOutput, "boom");
			assert.equal(r.summaryLine, "s");
			assert.equal(r.budgetExceeded, undefined);
			assert.equal(r.textOutput, "");
			assert.equal(r.toolCount, 0);

			// existsSync guard path through the orchestrator (identical shape)
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const badCwd = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				cwd: "/nonexistent-path-xyz",
			});
			assert.equal(badCwd.success, false);
			assert.ok(badCwd.summaryLine.includes("Worktree missing"));
			assert.equal(badCwd.budgetExceeded, undefined);
			assert.equal(badCwd.errorOutput, `cwd does not exist: /nonexistent-path-xyz`);

			// spawn-error path through the orchestrator (identical shape)
			resetMock();
			const errPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			for (const h of currentMockChild!._ref.errorHandlers) {
				h(new Error("ENOENT: spawn pi ENOENT"));
			}
			const spawnErr = await errPromise;
			assert.equal(spawnErr.success, false);
			assert.ok(spawnErr.output.includes("Failed to start pi"));
			assert.equal(spawnErr.errorOutput, "ENOENT: spawn pi ENOENT");
			assert.equal(spawnErr.budgetExceeded, undefined);
		});
	});
}
