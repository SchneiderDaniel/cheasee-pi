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
	cleanupOnExit,
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

// Split from crash-cleanup.test.mts (issue #2035 Long File refactor).
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
		assert.deepEqual(execCalls[1]!.args, [
			"worktree",
			"remove",
			"--force",
			"--force",
			WORKTREE_PATH,
		]);
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

		// Let microtasks drain: branch deletion resolved, setTimeout called for race.
		// execChecked() adds an extra async layer over pi.exec — drain enough turns.
		for (let i = 0; i < 10 && timeoutInfo.reject === null; i++) {
			await Promise.resolve();
		}

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

	it("shouldSkip=true (timeout preservation failed) → no cleanup exec, worktree + branch kept, exit(0)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const exitSpy = mock.fn() as unknown as (code: number) => void;
		const deps = createMinimalDeps({ pi, exit: exitSpy, shouldSkip: () => true });

		await cleanupOnExit("SIGTERM", deps);

		assert.equal(execCalls.length, 0, "no git commands — worktree + branch kept");
		const exitMock = exitSpy as unknown as MockedFn;
		assert.equal(exitMock.mock.calls.length, 1);
		assert.equal(exitMock.mock.calls[0]!.arguments[0], 0);
	});
});

// ══════════════════════════════════════════════════════════════════
// Phase 2 extended: isCleaningUp guard (via createCrashCleanup)
// ══════════════════════════════════════════════════════════════════
