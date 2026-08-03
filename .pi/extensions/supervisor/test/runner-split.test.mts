/**
 * runner-split.test.mts — barrel contract + size guards for the runner/ split
 * (Clean Code Audit #1405, issue #1408).
 *
 * Guards the behavior-preserving file split:
 *  - agent/runner.ts remains a 1-line shim re-exporting runner/index.ts
 *  - all 4 public symbols still resolve through the shim
 *  - runner/index.ts uses star re-exports only (no TS1205-fragile named
 *    type re-export), matching event/adapter/index.ts
 *  - per-module nbnc (non-blank/non-comment) line budget ≤ 500 (S104)
 *  - per-module max function span ≤ 100, runAgentSubprocess span < 100 (S138)
 *  - only runner/spawn.ts imports node:child_process (module-mock intercept)
 *  - spawn exit/close wiring: 'exit' reaps but does not resolve, 'close'
 *    resolves after stdio drains (Bug 3 contract)
 *  - stream line parse incl. unterminated-final-line flush + symmetric
 *    500K caps; malformed JSON line survives the split
 *  - budget exactly-once kill + classifyKillReason
 *  - cleanup result assembly byte-for-byte corpus + failResult shape
 *  - widget debounce/heartbeat/dispose idempotency
 */

import { describe, it, mock, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { DEFAULT_AGENT_TIMEOUT_MS as CONFIG_TIMEOUT } from "../config/config.ts";
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
	"cleanup.ts",
	"ui.ts",
	"index.ts",
];

// ─── Mock child process harness ───────────────────────────────────
// Mirrors test/agent-runner-subprocess.test.mts: mock.module intercepts
// `spawn` at module load; all real exports are preserved.

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

// ─── Granular event emitters (data → exit → close ordering is caller-controlled) ──

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

/** Full harness flow: stdout data → stderr data → 'exit' → 'close'. */
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

// ─── Structure-guard helpers (mirror adapter-split.test.mts) ─────

/** Non-blank/non-comment line count — mirrors the issue's awk-style measure. */
function nbnc(source: string): number {
	return source.split("\n").filter((line) => {
		const t = line.trim();
		if (t === "") return false;
		if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
		return true;
	}).length;
}

/** Line span of a named function in a single module source. */
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

/** Max brace-balanced span of any function (named or const-arrow) in a module. */
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

// ─── Tests ────────────────────────────────────────────────────────
// If mock.module unavailable, skip all tests (requires --experimental-test-module-mocks).

if (!hasMockModule) {
	describe("runner-split", () => {
		it("requires --experimental-test-module-mocks flag (Node.js < 23)", (t) => t.skip());
	});
}

if (hasMockModule) {
	// ── Phase 1: shim + export surface + size guards ──────────────

	describe("runner/ split — shim + export surface", () => {
		it("agent/runner.ts remains a file: 1-line re-export shim", () => {
			assert.ok(existsSync(SHIM_FILE), "agent/runner.ts exists (shim, not directory)");
			const shim = readFileSync(SHIM_FILE, "utf-8").trim();
			assert.equal(shim, 'export * from "./runner/index.ts";');
		});

		it("exports all 4 public symbols from the shim", async () => {
			const mod = await import("../agent/runner.ts");
			assert.equal(typeof mod.runAgent, "function", "runAgent exported");
			assert.equal(typeof mod.runAgentSubprocess, "function", "runAgentSubprocess exported");
			assert.equal(typeof mod.buildSubprocessArgs, "function", "buildSubprocessArgs exported");
			assert.equal(
				mod.DEFAULT_AGENT_TIMEOUT_MS,
				CONFIG_TIMEOUT,
				"DEFAULT_AGENT_TIMEOUT_MS deep-equals config value",
			);
		});

		it("runner/index.ts uses star re-exports only (no TS1205-fragile named re-export)", () => {
			const src = readFileSync(join(RUNNER_DIR, "index.ts"), "utf-8");
			assert.ok(!src.includes("export {"), "index.ts must not use named re-exports");
			for (const mod of MODULES) {
				if (mod === "index.ts") continue;
				assert.ok(src.includes(`export * from "./${mod}";`), `index.ts star-re-exports ${mod}`);
			}
		});

		it("SAFE_TASK_CHARS co-located with buildSubprocessArgs in args.ts", () => {
			const src = readFileSync(join(RUNNER_DIR, "args.ts"), "utf-8");
			assert.ok(src.includes("SAFE_TASK_CHARS = 1_200_000"), "SAFE_TASK_CHARS = 1_200_000");
			assert.ok(src.includes("export function buildSubprocessArgs"));
			assert.ok(src.includes("export function warnIfArgsLarge"));
		});

		it("size guards: every runner/*.ts ≤ 500 nbnc; max function span ≤ 100; orchestrator < 100", () => {
			for (const mod of MODULES) {
				const src = readFileSync(join(RUNNER_DIR, mod), "utf-8");
				const n = nbnc(src);
				assert.ok(n <= 500, `${mod} nbnc ${n} ≤ 500`);
				const span = maxFunctionSpan(src);
				assert.ok(span <= 100, `${mod} maxFunctionSpan ${span} ≤ 100`);
			}
			const idx = readFileSync(join(RUNNER_DIR, "index.ts"), "utf-8");
			const orchSpan = functionSpan(idx, "runAgentSubprocess");
			assert.ok(orchSpan !== null, "runAgentSubprocess found in index.ts");
			assert.ok(orchSpan! < 100, `runAgentSubprocess span ${orchSpan} < 100`);
		});
	});

	// ── Phase 2: spawn.ts exit/close wiring ───────────────────────

	describe("runner/spawn.ts — exit/close wiring", () => {
		it("only spawn.ts imports node:child_process in runner/", () => {
			for (const mod of MODULES) {
				const src = readFileSync(join(RUNNER_DIR, mod), "utf-8");
				if (mod === "spawn.ts") {
					assert.ok(
						src.includes('from "node:child_process"'),
						"spawn.ts imports node:child_process",
					);
				} else {
					assert.ok(
						!src.includes("node:child_process"),
						`${mod} must not import node:child_process (mock intercept)`,
					);
				}
			}
		});

		it("sub-module is standalone-importable with no top-level I/O or spawn", async () => {
			const mod = await import("../agent/runner/spawn.ts");
			assert.equal(typeof mod.spawnAgentChild, "function");
			assert.equal(currentMockChild, null, "no spawn occurred at import time");
		});

		it("'exit' reaps but does not resolve; 'close' resolves after trailing stdio", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			// chunk 1: text with newline → fullLog entry
			emitStdoutLines([
				JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "First chunk\n" },
				}),
				JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
			]);
			emitExit(0, null); // process table reaped — must NOT resolve
			// chunk 2: trailing stdio AFTER 'exit' — must not be dropped
			emitStdoutLines([
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "Second chunk\n" },
				}),
				JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
			]);
			emitClose(0, null);

			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.ok(result.textOutput.includes("First chunk"), "textOutput includes pre-exit chunk");
			assert.ok(
				result.textOutput.includes("Second chunk"),
				"textOutput includes trailing post-exit chunk (close resolves after stdio drains)",
			);
		});
	});

	// ── Phase 3: stream.ts line parse + caps ──────────────────────

	describe("runner/stream.ts — line parse + caps", () => {
		it("unterminated final JSON line is flushed at child 'close'", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);

			emitStdoutLines([
				JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "Trailing " },
				}),
			]);
			// final line WITHOUT trailing "\n" — sits in the buffer until flush
			emitStdoutRaw(JSON.stringify({ type: "message_update", delta: { type: "text_end" } }));
			emitExit(0, null);
			emitClose(0, null);

			const result = await resultPromise;
			assert.ok(
				result.textOutput.includes("Trailing"),
				`textOutput includes trailing unterminated event: ${JSON.stringify(result.textOutput)}`,
			);
		});

		it("stdout > 500K keeps the last 500K (slice(-keep) preserved)", async () => {
			const { createLineStream } = await import("../agent/runner/stream.ts");
			const lines: string[] = [];
			const stream = createLineStream({ onLine: (l) => lines.push(l) });
			// 6 chunks × 100K = 600K total → sliding window keeps last 500K
			for (let i = 1; i <= 6; i++) {
				stream.handleStdout(Buffer.from(String(i).repeat(100_000)));
			}
			assert.equal(stream.rawStdout.length, 500_000, "rawStdout capped at 500K");
			assert.ok(
				stream.rawStdout.startsWith("2".repeat(1_000)),
				"oldest 100K dropped (starts with chunk 2)",
			);
			assert.ok(
				stream.rawStdout.endsWith("6".repeat(1_000)),
				"newest 100K kept (ends with chunk 6)",
			);
		});

		it("stderr > 500K keeps the last 500K (symmetric cap)", async () => {
			const { createLineStream } = await import("../agent/runner/stream.ts");
			const stream = createLineStream({ onLine: () => {} });
			for (let i = 1; i <= 6; i++) {
				stream.handleStderr(Buffer.from(String(i).repeat(100_000)));
			}
			assert.equal(stream.stderr.length, 500_000, "stderr capped at 500K");
			assert.ok(
				stream.stderr.startsWith("2".repeat(1_000)),
				"symmetric keep-last: starts with chunk 2",
			);
		});

		it("malformed JSON line does not throw; parse-error warn pushed; stream continues", async () => {
			resetMock();
			const { ErrorCollector, getErrorCollector, setErrorCollector, resetErrorCollector } =
				await import("../pipeline/error-collector.ts");
			resetErrorCollector();
			setErrorCollector(new ErrorCollector()); // default is a no-op collector
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			// A throwing sendMessage exercises the handleLine catch (the parse-error
			// path) deterministically — same try/catch that guards the JSON stream.
			const throwingPi = {
				sendMessage: () => {
					throw new Error("sendMessage boom");
				},
			} as any;
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				undefined,
				undefined,
				undefined,
				throwingPi,
			);

			emitMockEvents({
				stdoutLines: [
					"{not valid json",
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "After malformed line" },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			});

			const result = await resultPromise;
			assert.equal(result.success, true, "malformed line does not fail the run");
			assert.ok(
				result.textOutput.includes("After malformed line"),
				"stream continues after malformed line",
			);
			const streamWarns = getErrorCollector().flush("stream");
			assert.ok(
				streamWarns.some((r) => r.message.includes("JSON parse error: Error: sendMessage boom")),
				"errorCollector received the parse-error warn",
			);
		});
	});

	// ── Phase 4: budget.ts kill policy ─────────────────────────────

	describe("runner/budget.ts — kill policy", () => {
		it("multiple budget-exceeding events → exactly one SIGTERM", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				1, // maxToolCalls = 1
			);

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
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				1,
			);

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

	// ── Phase 5: cleanup.ts + ui.ts result assembly + widget ──────

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
			const resultPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);
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
			const resultPromise = runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				undefined,
				1,
			);

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
			const badCwd = await runAgentSubprocess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
				"/nonexistent-path-xyz",
			);
			assert.equal(badCwd.success, false);
			assert.ok(badCwd.summaryLine.includes("Worktree missing"));
			assert.equal(badCwd.budgetExceeded, undefined);
			assert.equal(badCwd.errorOutput, `cwd does not exist: /nonexistent-path-xyz`);

			// spawn-error path through the orchestrator (identical shape)
			resetMock();
			const errPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);
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
			const okPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);
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
			const errPromise = runAgentSubprocess(mockAgent as any, "test task", mockCtx, 5000);
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
}
