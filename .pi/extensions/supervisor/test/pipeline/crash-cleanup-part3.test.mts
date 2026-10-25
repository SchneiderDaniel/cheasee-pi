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
	setupCrashCleanup,
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
