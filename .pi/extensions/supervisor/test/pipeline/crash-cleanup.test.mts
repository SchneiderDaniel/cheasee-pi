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
