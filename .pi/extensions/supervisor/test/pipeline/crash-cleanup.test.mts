// ─── Tests: pipeline/crash-cleanup.ts ────────────────────────────
// Tests for createCrashCleanup() and cleanupOnExit().
// Phases 1-2: signal handler registration/teardown, cleanup logic.
// Phase 3: wiring into handler.ts (tested via handler.test.mts).
//
// Run: node --experimental-strip-types --test-concurrency=1 \
//      .pi/extensions/supervisor/test/pipeline/crash-cleanup.test.mts

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugLogger } from "../../lib/debug.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";
import {
	createCrashCleanup,
	cleanupOnExit,
	setupCrashCleanup,
	withCrashCleanup,
	CLEANUP_TIMEOUT_MS,
	type CleanupOnExitDeps,
} from "../../pipeline/crash-cleanup.ts";

// ─── Mock Helper Type ────────────────────────────────────────────

/** Wrapper for mock.fn() results — exposes .mock.calls and .mock.restore */
type MockedFn = {
	(...args: unknown[]): unknown;
	mock: {
		calls: Array<{ arguments: unknown[] }>;
		restore: () => void;
	};
};

/** Type-safe debug logger with a mockable error spy */
interface MockedDebugLogger extends DebugLogger {
	error: MockedFn;
}

// ─── Test Fixtures ────────────────────────────────────────────────

const WORKTREE_PATH = "/repo/../worktrees/wt-test";
const WORKTREE_BRANCH = "worktree-wt-test";
const CWD = "/repo";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results?: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	const state = { idx: 0 };
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			if (results && state.idx < results.length) {
				const r = results[state.idx]!;
				state.idx++;
				if (r.code !== 0) {
					return Promise.reject(new Error(r.stderr || r.stdout || `Command failed: ${cmd}`));
				}
				return Promise.resolve(r);
			}
			// Hanging promise — never resolves
			return new Promise<{ code: number; stdout: string; stderr: string }>(() => {});
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockNotify(): NotifyFn {
	return {
		info: () => {},
		error: () => {},
	};
}

function createMockedDebugLogger(): MockedDebugLogger {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: mock.fn() as unknown as MockedFn,
		child: () => createMockedDebugLogger(),
		getSessionId: () => "test-session",
		getLogPath: () => "/tmp/test.log",
	};
}

function createMinimalDeps(overrides?: Partial<CleanupOnExitDeps>): CleanupOnExitDeps {
	return {
		worktreePath: WORKTREE_PATH,
		worktreeBranch: WORKTREE_BRANCH,
		pi: createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]),
		cwd: CWD,
		notify: createMockNotify(),
		debugLogger: createMockedDebugLogger(),
		exit: mock.fn() as unknown as (code: number) => void,
		...overrides,
	};
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Wait for microtasks to settle. */
async function yieldMicrotask(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

// Reset mocks between tests
beforeEach(() => {
	mock.reset();
});

afterEach(() => {
	mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════
// Phase 1: Signal Handler Setup/Teardown
// ══════════════════════════════════════════════════════════════════

describe("createCrashCleanup() — Phase 1: setup/teardown", () => {
	it("register() calls process.on('SIGTERM', handler) and process.on('SIGINT', handler)", () => {
		const onSpy = mock.method(process, "on") as unknown as MockedFn;
		const deps = createMinimalDeps();
		const cleanup = createCrashCleanup(deps);

		cleanup.register();

		assert.equal(onSpy.mock.calls.length, 2);
		const signals = onSpy.mock.calls.map((c) => c.arguments[0]);
		assert.ok(signals.includes("SIGTERM"));
		assert.ok(signals.includes("SIGINT"));

		// Both calls should register the same handler reference
		assert.equal(onSpy.mock.calls[0]!.arguments[1], onSpy.mock.calls[1]!.arguments[1]);
		onSpy.mock.restore();
	});

	it("teardown() calls process.removeListener('SIGTERM', handler) and process.removeListener('SIGINT', handler)", () => {
		const removeSpy = mock.method(process, "removeListener") as unknown as MockedFn;
		const deps = createMinimalDeps();
		const cleanup = createCrashCleanup(deps);

		cleanup.register();
		cleanup.teardown();

		assert.equal(removeSpy.mock.calls.length, 2);
		const signals = removeSpy.mock.calls.map((c) => c.arguments[0]);
		assert.ok(signals.includes("SIGTERM"));
		assert.ok(signals.includes("SIGINT"));

		// Both calls should remove the same handler reference
		assert.equal(removeSpy.mock.calls[0]!.arguments[1], removeSpy.mock.calls[1]!.arguments[1]);
		removeSpy.mock.restore();
	});

	it("teardown() is idempotent — second call does not throw", () => {
		const removeSpy = mock.method(process, "removeListener") as unknown as MockedFn;
		const deps = createMinimalDeps();
		const cleanup = createCrashCleanup(deps);

		cleanup.register();
		cleanup.teardown();

		// Second call should not throw
		cleanup.teardown();

		// 2 calls from first teardown + 2 from second = 4
		assert.equal(removeSpy.mock.calls.length, 4);
		removeSpy.mock.restore();
	});
});

// ══════════════════════════════════════════════════════════════════
// Phase 2: cleanupOnExit — timeout race, error handling, reordered branch deletion
// ══════════════════════════════════════════════════════════════════
//
// Branch deletion now runs FIRST (before the race), so exec order invariant:
//   execCall[0] = git branch -D
//   execCall[1] = git worktree remove --force
//   execCall[2] = git worktree prune

async function makeTimeoutDeps(
	overrides?: Partial<CleanupOnExitDeps> & {
		execResults?: Array<{ code: number; stdout: string; stderr: string }>;
		execCalls?: ExecCall[];
	},
): Promise<{
	deps: CleanupOnExitDeps;
	timeoutInfo: {
		ms: number | null;
		unrefCalled: boolean;
		reject: ((err: Error) => void) | null;
	};
	cleanupPromise: Promise<void>;
}> {
	const execCalls = overrides?.execCalls || [];
	const pi = createMockPi(overrides?.execResults || [], execCalls);
	const exitSpy = mock.fn() as unknown as (code: number) => void;
	const debugLogger = createMockedDebugLogger();

	const timeoutInfo: {
		ms: number | null;
		unrefCalled: boolean;
		reject: ((err: Error) => void) | null;
	} = { ms: null, unrefCalled: false, reject: null };

	mock.method(globalThis, "setTimeout", ((fn: (...args: unknown[]) => void, ms: number) => {
		timeoutInfo.ms = ms;
		timeoutInfo.reject = fn as (err: Error) => void;
		return {
			unref: () => {
				timeoutInfo.unrefCalled = true;
				return {} as NodeJS.Timeout;
			},
		} as unknown as NodeJS.Timeout;
	}) as typeof globalThis.setTimeout);

	const deps = createMinimalDeps({
		pi,
		exit: exitSpy,
		debugLogger,
		...overrides,
	});

	const cleanupPromise = cleanupOnExit("SIGTERM", deps);

	// Wait for branch deletion to complete (the await deleteBranch call)
	await Promise.resolve();
	await Promise.resolve();

	return { deps, timeoutInfo, cleanupPromise };
}

describe("cleanupOnExit() — Phase 2: cleanup logic (reordered: branch first)", () => {
	it("SIGTERM happy path: exec order = [branch -D, worktree remove --force, worktree prune]; exit(0)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({ pi, exit: exitSpy });

		await cleanupOnExit("SIGTERM", deps);

		// Three git commands executed: branch -D FIRST, then remove + prune
		assert.equal(execCalls.length, 3);
		assert.deepEqual(
			execCalls[0]!.args,
			["branch", "-D", WORKTREE_BRANCH],
			"branch -D must be first exec call",
		);
		assert.deepEqual(execCalls[1]!.args, ["worktree", "remove", "--force", WORKTREE_PATH]);
		assert.deepEqual(execCalls[2]!.args, ["worktree", "prune"]);

		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("SIGINT happy path: same exec order as SIGTERM", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const debugLogger = createMockedDebugLogger();
		const deps = createMinimalDeps({ pi, exit: exitSpy, debugLogger });

		await cleanupOnExit("SIGINT", deps);

		// Verify exec order invariant
		assert.equal(execCalls.length, 3);
		assert.deepEqual(
			execCalls[0]!.args,
			["branch", "-D", WORKTREE_BRANCH],
			"branch -D must be first exec call",
		);

		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);

		// No error logged on happy path
		assert.equal(debugLogger.error.mock.calls.length, 0);
	});

	it("worktreePath undefined: cleanup skipped → exit(0) called", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({
			worktreePath: undefined,
			worktreeBranch: WORKTREE_BRANCH,
			pi,
			exit: exitSpy,
		});

		await cleanupOnExit("SIGTERM", deps);

		assert.equal(execCalls.length, 0);
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("worktreeBranch undefined: cleanup skipped → exit(0) called", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({
			worktreePath: WORKTREE_PATH,
			worktreeBranch: undefined,
			pi,
			exit: exitSpy,
		});

		await cleanupOnExit("SIGTERM", deps);

		assert.equal(execCalls.length, 0);
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("both worktreePath and worktreeBranch undefined: cleanup skipped → exit(0) called", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({
			worktreePath: undefined,
			worktreeBranch: undefined,
			pi,
			exit: exitSpy,
		});

		await cleanupOnExit("SIGTERM", deps);

		assert.equal(execCalls.length, 0);
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("branch deletion fails, race succeeds: error logged for branch; worktree remove + prune still run", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "branch not found" }, // branch -D fails
				{ code: 0, stdout: "", stderr: "" }, // worktree remove succeeds
				{ code: 0, stdout: "", stderr: "" }, // worktree prune succeeds
			],
			execCalls,
		);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const debugLogger = createMockedDebugLogger();
		const deps = createMinimalDeps({ pi, exit: exitSpy, debugLogger });

		await cleanupOnExit("SIGTERM", deps);

		// All 3 exec calls made (branch fail, remove, prune)
		assert.equal(execCalls.length, 3);
		assert.deepEqual(execCalls[0]!.args, ["branch", "-D", WORKTREE_BRANCH]);

		// Branch deletion error logged
		assert.ok(debugLogger.error.mock.calls.length >= 1, "Branch deletion error logged");
		const branchErrMsg: string = debugLogger.error.mock.calls[0]!.arguments[1] as string;
		assert.ok(
			branchErrMsg.includes("branch deletion failed"),
			"First error should mention branch deletion",
		);

		// exit(0) still called
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("branch deletion fails, race also fails: both errors logged; exit(0) still called", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "branch not found" }, // branch -D fails
				{ code: 1, stdout: "", stderr: "worktree locked" }, // worktree remove fails
			],
			execCalls,
		);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const debugLogger = createMockedDebugLogger();
		const deps = createMinimalDeps({ pi, exit: exitSpy, debugLogger });

		await cleanupOnExit("SIGTERM", deps);

		// 2 exec calls: branch -D fails, worktree remove fails
		assert.equal(execCalls.length, 2);
		assert.deepEqual(execCalls[0]!.args, ["branch", "-D", WORKTREE_BRANCH]);

		// Branch error logged
		assert.ok(
			debugLogger.error.mock.calls.length >= 2,
			"Both branch deletion and race errors logged",
		);
		const branchErrMsg: string = debugLogger.error.mock.calls[0]!.arguments[1] as string;
		assert.ok(
			branchErrMsg.includes("branch deletion failed"),
			"First error should mention branch deletion",
		);

		// Race error also logged
		const raceErrMsg: string = debugLogger.error.mock.calls[1]!.arguments[1] as string;
		assert.ok(raceErrMsg.includes("cleanup failed"), "Second error should mention cleanup failure");

		// exit(0) still called
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("race cleanup fails (worktree remove non-zero): error caught in catch; exit(0) called; branch already deleted", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // branch -D succeeds
				{ code: 1, stdout: "", stderr: "failed to remove" }, // worktree remove fails
			],
			execCalls,
		);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const debugLogger = createMockedDebugLogger();
		const deps = createMinimalDeps({ pi, exit: exitSpy, debugLogger });

		await cleanupOnExit("SIGTERM", deps);

		// 2 exec calls: branch -D, worktree remove (prune never reached)
		assert.equal(execCalls.length, 2);
		assert.deepEqual(
			execCalls[0]!.args,
			["branch", "-D", WORKTREE_BRANCH],
			"Branch -D must still be first exec call",
		);

		// Error logged for race failure
		assert.ok(debugLogger.error.mock.calls.length >= 1, "Race error should be logged");
		const raceErrMsg: string = debugLogger.error.mock.calls[0]!.arguments[1] as string;
		assert.ok(
			raceErrMsg.includes("cleanup failed"),
			"Error should mention cleanup failure, not branch deletion",
		);

		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});

	it("timeout wins race (worktree remove hangs): branch already deleted; timeout caught; exit(0) called", async () => {
		// Branch deletion succeeds (1 result), worktree remove hangs (no more results)
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const debugLogger = createMockedDebugLogger();

		const timeoutInfo: {
			ms: number | null;
			unrefCalled: boolean;
			reject: ((err: Error) => void) | null;
		} = { ms: null, unrefCalled: false, reject: null };

		mock.method(globalThis, "setTimeout", ((fn: (...args: unknown[]) => void, ms: number) => {
			timeoutInfo.ms = ms;
			timeoutInfo.reject = fn as (err: Error) => void;
			return {
				unref: () => {
					timeoutInfo.unrefCalled = true;
					return {} as NodeJS.Timeout;
				},
			} as unknown as NodeJS.Timeout;
		}) as typeof globalThis.setTimeout);

		const deps = createMinimalDeps({ pi, exit: exitSpy, debugLogger });

		// Start cleanup — branch deletion completes synchronously (resolved promise),
		// then race starts with hanging worktree remove
		const cleanupPromise = cleanupOnExit("SIGTERM", deps);

		// Let microtasks drain: branch deletion resolved, setTimeout called for race
		await Promise.resolve();
		await Promise.resolve();

		// At this point, branch -D completed and worktree remove was attempted
		// (but hangs). execCalls[0] is always git branch -D.
		assert.ok(execCalls.length >= 1, "At least branch -D exec call happened before timeout");
		assert.deepEqual(
			execCalls[0]!.args,
			["branch", "-D", WORKTREE_BRANCH],
			"Invariant: exec call #1 is always git branch -D",
		);

		// Timeout was configured
		assert.ok(timeoutInfo.reject !== null, "setTimeout should have been called for race");
		assert.equal(timeoutInfo.ms, CLEANUP_TIMEOUT_MS);

		// Manually trigger the timeout rejection
		timeoutInfo.reject!(new Error(`Cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms`));

		await cleanupPromise;

		// .unref() was called
		assert.ok(timeoutInfo.unrefCalled, "setTimeout(...).unref() should be called");

		// Error logged for timeout
		assert.ok(debugLogger.error.mock.calls.length >= 1, "Expected error log for timeout");
		const loggedMsg: string = debugLogger.error.mock.calls[0]!.arguments[1] as string;
		assert.equal(loggedMsg, "Signal SIGTERM cleanup failed");
		const loggedData = debugLogger.error.mock.calls[0]!.arguments[2] as Record<string, unknown>;
		assert.ok(String(loggedData?.error).includes("timed out"), "Data error should mention timeout");

		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);

		// execCalls[0] is always branch -D (invariant preserved)
		// worktree remove may have been attempted (pushed to execCalls) but hangs
		assert.deepEqual(
			execCalls[0]!.args,
			["branch", "-D", WORKTREE_BRANCH],
			"Invariant: exec call #0 is always git branch -D (preserved across timeout)",
		);
	});
});

// ══════════════════════════════════════════════════════════════════
// Phase 2 extended: isCleaningUp guard (via createCrashCleanup)
// ══════════════════════════════════════════════════════════════════

describe("createCrashCleanup() — Phase 2: guard", () => {
	it("isCleaningUp guard: second signal during cleanup → exit(1) immediately, cleanupWorktree not called twice", async () => {
		const execCalls: ExecCall[] = [];
		// Pi.exec that hangs (never resolves) so first cleanup never completes
		const hangingPi = createMockPi([], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({ pi: hangingPi, exit: exitSpy });

		// Spy on process.on to capture the registered handler
		const capturedHandlers: Array<(signal: string) => Promise<void>> = [];
		mock.method(process, "on", ((_signal: string, handler: (...args: unknown[]) => void) => {
			capturedHandlers.push(handler as (signal: string) => Promise<void>);
			return process;
		}) as typeof process.on);

		const { register, teardown } = createCrashCleanup(deps);
		register();

		// Get the captured handler (both SIGTERM and SIGINT share the same handler)
		const handler = capturedHandlers[0]!;

		// First signal — starts cleanup, but pi.exec hangs so cleanupOnExit stalls
		handler("SIGTERM");
		await yieldMicrotask();

		const exitMock = exitSpy as unknown as MockedFn;

		// exit should NOT have been called yet (cleanup hangs, timeout not triggered)
		assert.equal(exitMock.mock.calls.length, 0);

		// Second signal — guard should fire: isCleaningUp is true → exit(1)
		handler("SIGINT");
		await yieldMicrotask();

		// Guard calls exit(1) immediately
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 1);

		// cleanupOnExit should NOT have been entered a second time
		// (guard returns before reaching cleanupOnExit).
		// First call started deleteBranch which pushed 1 exec call
		// (the hanging pi.exec promise). Second call was guarded.
		// If guard were missing, we'd see 2 exec calls.
		assert.equal(execCalls.length, 1, "Exactly 1 exec call (from first signal only)");

		teardown();
		mock.restoreAll();
	});
});

// ══════════════════════════════════════════════════════════════════
// Phase 3: Wiring — lifecycle wrapper functions
// ══════════════════════════════════════════════════════════════════

describe("setupCrashCleanup() — Phase 3: signal handler setup", () => {
	it("returns a CrashCleanup object with register and teardown methods", () => {
		const deps = createMinimalDeps();
		const cc = setupCrashCleanup(deps);

		assert.equal(typeof cc.register, "function");
		assert.equal(typeof cc.teardown, "function");

		// Must call teardown to clean up registered handlers
		cc.teardown();
	});

	it("register() calls process.on for SIGTERM and SIGINT", () => {
		const onSpy = mock.method(process, "on") as unknown as MockedFn;
		const deps = createMinimalDeps();
		const cc = setupCrashCleanup(deps);

		// register was called by setupCrashCleanup — verify process.on was called
		assert.equal(onSpy.mock.calls.length, 2);
		const signals = onSpy.mock.calls.map((c) => c.arguments[0]);
		assert.ok(signals.includes("SIGTERM"));
		assert.ok(signals.includes("SIGINT"));

		// Both signal handlers should be the same function reference
		assert.equal(onSpy.mock.calls[0]!.arguments[1], onSpy.mock.calls[1]!.arguments[1]);

		// Cleanup
		cc.teardown();
		onSpy.mock.restore();
	});
});

describe("withCrashCleanup() — Phase 3: lifecycle wrapper", () => {
	it("calls process.on before callback and process.removeListener after on success", async () => {
		const order: string[] = [];
		const origOn = process.on.bind(process);
		const origRemove = process.removeListener.bind(process);

		// Spy with implementation to track order
		const onSpy = mock.method(
			process,
			"on",
			(signal: string, handler: (...args: unknown[]) => void) => {
				order.push("on");
				return origOn(signal, handler);
			},
		);
		const removeSpy = mock.method(
			process,
			"removeListener",
			(signal: string, handler: (...args: unknown[]) => void) => {
				order.push("removeListener");
				return origRemove(signal, handler);
			},
		);

		const deps = createMinimalDeps();

		await withCrashCleanup(deps, async () => {
			order.push("callback");
			return "ok";
		});

		// Order: setup (process.on) → callback → teardown (process.removeListener)
		assert.ok(order.indexOf("on") < order.indexOf("callback"), "process.on before callback");
		assert.ok(
			order.indexOf("callback") < order.indexOf("removeListener"),
			"callback before process.removeListener",
		);

		onSpy.mock.restore();
		removeSpy.mock.restore();
	});

	it("calls process.removeListener in finally even when callback throws", async () => {
		const origOn = process.on.bind(process);
		const origRemove = process.removeListener.bind(process);

		const onSpy = mock.method(process, "on", (...args: unknown[]) =>
			origOn(...(args as [string, (...args: unknown[]) => void])),
		);
		const removeSpy = mock.method(process, "removeListener", (...args: unknown[]) =>
			origRemove(...(args as [string, (...args: unknown[]) => void])),
		);

		const deps = createMinimalDeps();
		const testError = new Error("callback error");

		await assert.rejects(
			withCrashCleanup(deps, async () => {
				throw testError;
			}),
			testError,
		);

		// removeListener was called even though callback threw
		assert.ok(
			removeSpy.mock.calls.length >= 2,
			"removeListener should be called (SIGTERM + SIGINT)",
		);

		onSpy.mock.restore();
		removeSpy.mock.restore();
	});

	it("passes the crashCleanup instance to the callback", async () => {
		const deps = createMinimalDeps();
		let receivedCC: unknown;

		await withCrashCleanup(deps, async (cc) => {
			receivedCC = cc;
			return "ok";
		});

		// cc should have register and teardown methods
		assert.ok(receivedCC, "crashCleanup instance passed to callback");
		const cc = receivedCC as { register: () => void; teardown: () => void };
		assert.equal(typeof cc.register, "function");
		assert.equal(typeof cc.teardown, "function");
	});
});
