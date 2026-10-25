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
	describe("runAgentSubprocess — deadline watchdog + escalation", () => {
		it("deadline fires → SIGTERM then SIGKILL group kill; timeout result shape", async (t) => {
			resetMock();
			// mock.method keeps the original process.kill by default (the real
			// kill(-12345) would throw ESRCH); a no-op implementation isolates
			// the capture AND keeps the mock child's group "alive" for SIGKILL.
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			// timeoutMs=40, killGraceSec=0.05 → SIGTERM≈40ms, SIGKILL≈90ms
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 40,
				killGraceSec: 0.05,
			});

			await new Promise((r) => setTimeout(r, 130));

			const killCalls = killMock.mock.calls.map((c) => c.arguments);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGTERM"),
				`killGroup(SIGTERM) issued to -pid: ${JSON.stringify(killCalls)}`,
			);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGKILL"),
				`killGroup(SIGKILL) escalated after grace: ${JSON.stringify(killCalls)}`,
			);

			// Child 'close' still arrives (mock) → resolver classifies the timeout
			currentMockOpts = { exitCode: null, exitSignal: "SIGTERM" };
			emitMockEvents();
			const result = await resultPromise;

			assert.equal(result.success, false, "timeout run is a failure");
			assert.equal(result.timedOut, true);
			assert.equal(result.killReason, "timeout");
			assert.equal(result.configuredTimeoutMs, 40);
			assert.ok(result.durationMs >= 40, `durationMs ≈ bound, got ${result.durationMs}`);
			assert.match(
				result.errorOutput as string,
				/\[Timeout: test-agent exceeded 0s \(actual \d+ms\)\]/,
				"structured timeout note retained in errorOutput (pipeline state)",
			);
		});

		it("force-resolve bound: close never fires → resolves via doResolve(null, SIGTERM)", async (t) => {
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			// SIGTERM≈20ms, SIGKILL≈40ms, force-resolve≈60ms — close NEVER emitted.
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 20,
				killGraceSec: 0.02,
			});

			const result = await resultPromise;

			assert.equal(result.success, false, "setsid'd escape still yields a bounded failure");
			assert.equal(result.timedOut, true);
			assert.equal(result.killReason, "timeout");
			const killCalls = killMock.mock.calls.map((c) => c.arguments);
			assert.equal(
				killCalls.filter((a) => a[1] === "SIGKILL").length,
				1,
				"SIGKILL escalation happened before force-resolve",
			);
		});

		it("timeoutMs=null → no watchdog, no kills; normal exit still succeeds", async (t) => {
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: null,
			});

			await new Promise((r) => setTimeout(r, 50));
			assert.equal(killMock.mock.calls.length, 0, "no kill issued for null timeout");

			currentMockOpts = { exitCode: 0, exitSignal: null };
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.success, true, "normal child exit still succeeds");
			assert.equal(result.timedOut, undefined);
		});

		it("budget kill still classifies killReason=budget (regression)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
					JSON.stringify({ type: "tool_execution_end", toolName: "read" }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: "SIGTERM",
			};
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.budgetExceeded, true);
			assert.equal(result.killReason, "budget");
			assert.equal(result.timedOut, undefined, "budget kill is not a timeout");
		});

		it("plain code-0 exit has no killReason", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			currentMockOpts = { exitCode: 0, exitSignal: null };
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.equal(result.killReason, undefined);
		});

		it("leader exits after SIGTERM but descendant holds pipe → SIGKILL still issued (no orphan)", async (t) => {
			// Audit regression (finding #1): killGroup must NOT be gated on
			// childExited — the process group outlives its leader on Linux, so
			// the SIGKILL escalation has to reach descendants even after the
			// direct child was reaped. Sequence: SIGTERM group kill ≈30ms, then
			// the leader "exits" (childExited=true) while a descendant still
			// holds the pipe ('close' never fires) → SIGKILL ≈110ms must STILL
			// be issued → force-resolve ≈190ms bounds the run.
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 30,
				killGraceSec: 0.08,
			});

			// Let the SIGTERM group kill land, then reap the leader only
			// (childExited=true) — the descendant still holds the piped stdout.
			await sleep(70);
			currentMockChild?._ref.exitHandler?.(null, "SIGTERM");

			// SIGKILL escalation window — must fire despite childExited.
			await sleep(70);
			const killCalls = killMock.mock.calls.map((c) => c.arguments);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGTERM"),
				`SIGTERM group kill issued: ${JSON.stringify(killCalls)}`,
			);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGKILL"),
				`SIGKILL escalation issued AFTER leader exit (group kills descendants): ${JSON.stringify(killCalls)}`,
			);

			// close never fires (pipe held) → force-resolve bounds the run.
			const result = await resultPromise;
			assert.equal(result.timedOut, true, "force-resolve still classifies the timeout");
			assert.equal(result.success, false);
		});

		it("leader 'close' fires while timed out but before SIGKILL → SIGKILL still issued (audit finding #1)", async (t) => {
			// The leader exits (via SIGTERM) AND its stdio drains → 'close' fires
			// before the scheduled SIGKILL. The resolver must NOT dispose the
			// escalation ladder at that point: a descendant that closed its
			// inherited stdio but ignored SIGTERM still needs the SIGKILL.
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			// SIGTERM≈30ms, SIGKILL≈130ms (grace 0.1s)
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 30,
				killGraceSec: 0.1,
			});

			// Leader exits + pipe drains right after SIGTERM, still pre-SIGKILL.
			await sleep(60);
			currentMockOpts = { exitCode: null, exitSignal: "SIGTERM" };
			emitMockEvents();

			// Give the (formerly cancelled) SIGKILL step time to fire.
			await sleep(120);
			const killCalls = killMock.mock.calls.map((c) => c.arguments);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGTERM"),
				`SIGTERM group kill issued: ${JSON.stringify(killCalls)}`,
			);
			assert.ok(
				killCalls.some((a) => a[0] === -12345 && a[1] === "SIGKILL"),
				`SIGKILL escalation STILL issued after leader 'close' (no orphaned descendant): ${JSON.stringify(killCalls)}`,
			);

			const result = await resultPromise;
			assert.equal(result.timedOut, true, "close after the deadline still classifies the timeout");
			assert.equal(result.success, false);
		});

		it("non-ESRCH group-kill failure is surfaced in the timeout result (audit finding #2)", async (t) => {
			// process.kill(-pid) fails (EPERM): the pi process tree may still be
			// alive, so the result must carry the kill failure instead of reporting
			// a clean timeout while a process survives.
			resetMock();
			t.mock.method(process, "kill", () => {
				const err = new Error("operation not permitted") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			});
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			// close never fires → force-resolve bounds the run.
			const result = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 30,
				killGraceSec: 0.02,
			});

			assert.equal(result.timedOut, true);
			assert.equal(result.success, false);
			assert.match(
				result.errorOutput as string,
				/process-group kill failed — SIGTERM failed: EPERM/,
				"failed cleanup must be a visible terminal error, not a silent timeout",
			);
		});

		it("deadline exhausted before spawn (timeoutMs=0) → timeout result, no spawn, no kill (audit finding #3)", async (t) => {
			// The merge-conflict path calls runAgentSubprocess directly with a
			// resolved per-agent timeout; preparation (arg assembly / task spill)
			// counts against the absolute deadline. A window fully consumed by
			// preparation must yield a bounded timeout failure — not a fresh T.
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 0,
			});

			assert.equal(lastSpawnOpts, null, "no spawn once preparation exhausted the window");
			assert.equal(killMock.mock.calls.length, 0, "no kill issued — nothing was spawned");
			assert.equal(result.timedOut, true);
			assert.equal(result.success, false);
			assert.equal(result.killReason, "timeout");
			assert.equal(result.configuredTimeoutMs, 0);
			assert.match(
				result.errorOutput as string,
				/\[Timeout: test-agent exceeded 0s/,
				"structured timeout note authored for the pre-spawn exhaustion",
			);
		});

		it("enforcement uses the remaining budget but reports the CONFIGURED timeout (audit finding #3)", async (t) => {
			// Direct-call path (merge conflict dispatch): configured 300s with an
			// absolute deadline already spent → no fresh window is armed, and the
			// failure state reports 300_000ms, never the ~0 remaining budget.
			resetMock();
			const killMock = t.mock.method(process, "kill", () => undefined);
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 300_000,
				deadlineMs: Date.now() - 1,
			});

			assert.equal(lastSpawnOpts, null, "no spawn once the absolute deadline is spent");
			assert.equal(killMock.mock.calls.length, 0, "no kill issued — nothing was spawned");
			assert.equal(result.timedOut, true);
			assert.equal(
				result.configuredTimeoutMs,
				300_000,
				"configured duration reported, not the remaining enforcement budget",
			);
			assert.match(result.errorOutput as string, /exceeded 300s/);
		});
	});
}
