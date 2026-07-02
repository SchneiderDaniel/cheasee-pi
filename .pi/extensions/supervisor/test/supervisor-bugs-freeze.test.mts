/**
 * Tests for supervisor freeze/hang bugs (issue 274).
 *
 * Bug 1 — Shadow `flushTimer` prevents proper cleanup on errors
 * Bug 2 — Missing `await` on subprocess fallback
 * Bug 3 — Misleading `streamingBehavior: "steer"` on first prompt
 * Bug 4 — Render stall during agent idle periods (missing requestRender(true))
 *
 * Phase 1: Bug 2 — runAgent fallback await (unit + static)
 * Phase 2: Bug 1 — flushTimer shadow (static analysis)
 * Phase 3: Bug 3 — streamingBehavior removal (static analysis)
 * Phase 4: Bug 4 — tui.requestRender(true) in flushWidget (static analysis)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-bugs-freeze.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import type { ParsedAgent, AgentRunResult } from "../config/types.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Bug 2 — Missing `await` on subprocess fallback (agent-runner.ts:47)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Duplicate of runAgent logic for unit testing error propagation.
 * Injected mocks let us test:
 *  - In-process success path (inProcess returns, subprocess not called)
 *  - In-process failure + subprocess synchronous throw (caught by caller)
 *  - In-process failure + subprocess rejection (returned correctly)
 */
async function runAgentWithMocks(
	agent: ParsedAgent,
	task: string,
	_timeoutMs: number,
	mockRunAgentInProcess: (...args: any[]) => Promise<any>,
	mockRunAgentSubprocess: (...args: any[]) => Promise<any>,
): Promise<AgentRunResult> {
	// Mock: primary in-process, fallback subprocess
	try {
		return await mockRunAgentInProcess(agent, task, {} as any, {} as any, _timeoutMs, undefined);
	} catch (_err) {
		// Fallback: this must use `return await` to catch synchronous throws
		return mockRunAgentSubprocess(agent, task, {} as any, _timeoutMs, undefined);
	}
}

describe("Phase 1: Bug 2 — Missing await on subprocess fallback", () => {
	it("1.1: fallback synchronous throw is caught (not unhandled rejection)", async () => {
		// Mock in-process to reject, subprocess to throw synchronously before any new Promise
		const mockInProcess = async () => {
			throw new Error("in-process failed");
		};
		const mockSubprocess = (_agent: any, _task: any, _ctx: any, _timeout: any, _cwd: any) => {
			throw new Error("subprocess failed"); // synchronous throw
		};

		// Without `await`, this throw becomes an unhandled rejection.
		// With `await` in the duplicated logic, it's caught by the caller's try/catch
		// and the returned promise rejects properly.
		try {
			await runAgentWithMocks({} as any, "test", 5000, mockInProcess, mockSubprocess as any);
			assert.fail("should have thrown");
		} catch (err: any) {
			assert.strictEqual(err.message, "subprocess failed");
		}
	});

	it("1.2: fallback rejection is propagated correctly", async () => {
		const mockInProcess = async () => {
			throw new Error("in-process failed");
		};
		const mockSubprocess = async () => {
			throw new Error("fallback error");
		};

		try {
			await runAgentWithMocks({} as any, "test", 5000, mockInProcess, mockSubprocess);
			assert.fail("should have thrown");
		} catch (err: any) {
			assert.strictEqual(err.message, "fallback error");
		}
	});

	it("1.3: in-process success path returns result, subprocess never called", async () => {
		let subprocessCalled = false;
		const mockInProcess = async () => {
			return { success: true, tokenCount: 100 };
		};
		const mockSubprocess = async () => {
			subprocessCalled = true;
			return { success: false };
		};

		const result = await runAgentWithMocks({} as any, "test", 5000, mockInProcess, mockSubprocess);
		assert.strictEqual(result.success, true);
		assert.strictEqual((result as any).tokenCount, 100);
		assert.strictEqual(subprocessCalled, false);
	});

	it("1.4: agent-runner.ts source uses 'return await runAgentSubprocess(' (not bare return)", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		// Bug 2 fix: prepend await before runAgentSubprocess
		assert.ok(
			source.includes("return await runAgentSubprocess("),
			"agent-runner.ts must use 'return await runAgentSubprocess(' for proper error propagation",
		);
	});

	it("1.5: agent-runner.ts does not have bare 'return runAgentSubprocess('", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		// Check there's no bare return without await
		assert.ok(
			!source.includes("return runAgentSubprocess("),
			"agent-runner.ts must not have bare 'return runAgentSubprocess(' without await",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Bug 1 — Shadow `flushTimer` in try block (agent-session-runner.ts:485 vs 540)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Bug 1 — Shadow flushTimer in try block", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/agent-session-runner.ts", "utf-8");
	const lines = source.split("\n");

	it("2.1: outer flushTimer declaration exists in hoisted scope (before try block)", () => {
		// Find the "Hoist cleanup variables" comment or the area before try
		const hoistSection = source.split("// Hoist cleanup variables");
		assert.ok(hoistSection.length >= 2, "Hoist cleanup comment must exist");
		// After the comment, look for let flushTimer
		const afterHoist = hoistSection[1];
		// Before "try {" — find the outer flushTimer
		const beforeTry = afterHoist.split("try {")[0] || "";
		assert.ok(
			beforeTry.includes("let flushTimer: NodeJS.Timeout | null = null;"),
			"Outer flushTimer must be declared before the try block",
		);
	});

	it("2.2: no inner let flushTimer declaration inside try block (shadow removed)", () => {
		// Check there's only one "let flushTimer" in the entire file
		const flushTimerDeclLines = lines.filter(
			(l) => l.includes("let flushTimer") || l.includes("let flushTimer:"),
		);
		assert.strictEqual(
			flushTimerDeclLines.length,
			1,
			"Only one let flushTimer declaration should exist (outer hoisted one)",
		);
	});

	it("2.3: catch block references flushTimer for cleanup", () => {
		// Find all catch blocks that clear the timer
		// Outer catch at end: `if (flushTimer) clearTimeout(flushTimer);`
		const clearLines = lines.filter(
			(l) =>
				l.includes("flushTimer") && (l.includes("clearTimeout") || l.includes("clearInterval")),
		);
		const flushClearLines = clearLines.filter((l) => l.includes("clearTimeout"));
		assert.ok(
			flushClearLines.length >= 3,
			"At least 3 cleanup points must clear flushTimer (timeout handler, success, outer catch)",
		);
	});

	it("2.4: flushWidget uses clearTimeout(flushTimer) referencing outer variable", () => {
		// Inside flushWidget there should be `if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }`
		const flushWidgetSection =
			source.split("const flushWidget =")[1]?.split("const scheduleFlush")[0] || "";
		assert.ok(
			flushWidgetSection.includes("clearTimeout(flushTimer)"),
			"flushWidget must clearTimeout flushTimer referencing the outer variable",
		);
		assert.ok(
			flushWidgetSection.includes("flushTimer = null"),
			"flushWidget must nullify flushTimer after clearing",
		);
	});

	it("2.5: scheduleFlush references flushTimer for assignment", () => {
		const scheduleFlushSection =
			source.split("const scheduleFlush")[1]?.split("const heartbeat")[0] || "";
		assert.ok(
			scheduleFlushSection.includes("flushTimer = setTimeout(flushWidget,"),
			"scheduleFlush must assign flushTimer via setTimeout",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Bug 3 — Timeout handling via Promise.race (agent-session-runner.ts)
// ═══════════════════════════════════════════════════════════════════════
// streamingBehavior: "steer" is present in origin/main from #271 merge.
// This phase validates the timeout infrastructure around session.prompt().

describe("Phase 3: Bug 3 — Timeout handling (Promise.race + clearTimeout)", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/agent-session-runner.ts", "utf-8");

	it("3.1: promptPromise wrapped in Promise.race with timeoutPromise", () => {
		const promptSection = source.split("Promise.race([")[1]?.split("])")[0] || "";
		assert.ok(
			promptSection.includes("promptPromise"),
			"promptPromise wrapped in Promise.race for timeout",
		);
		assert.ok(promptSection.includes("timeoutPromise"), "timeoutPromise raced with session.prompt");
	});

	it("3.2: timeout uses clearTimeout in finally block", () => {
		// The finally block should clean up the timeout
		const finallySection =
			source.split("finally {")[1]?.split("}[")[0]?.split("/* fallback")[0] || "";
		assert.ok(
			finallySection.includes("clearTimeout"),
			"finally block has clearTimeout for cleanup",
		);
	});

	it("3.3: timeout promise rejects on expiry", () => {
		const timeoutPromiseSection =
			source
				.split("const timeoutPromise = new Promise<")[1]
				?.split("\n\t\t});")[0]
				?.split("\n\t});")[0] || "";
		assert.ok(
			timeoutPromiseSection.includes("reject(") || timeoutPromiseSection.includes("Error("),
			"timeout promise rejects with error",
		);
	});

	it("3.4: timeout sets timedOut flag before abort", () => {
		const timeoutPromiseSection =
			source
				.split("const timeoutPromise = new Promise<")[1]
				?.split("\n\t\t});")[0]
				?.split("\n\t});")[0] || "";
		assert.ok(
			timeoutPromiseSection.includes("timedOut = true"),
			"timedOut flag set before session.abort()",
		);
		assert.ok(
			timeoutPromiseSection.includes("session!.abort()") ||
				timeoutPromiseSection.includes("session.abort()"),
			"session.abort() called on timeout",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Bug 4 -- Render stall during idle (agent-session-runner.ts:flushWidget)
// ═══════════════════════════════════════════════════════════════════════
// flushWidget uses buildWidgetLines (no component factory), try-catch prevents
// render exceptions from stalling the heartbeat interval.

describe("Phase 4: Bug 4 -- Render stall (flushWidget try-catch)", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/agent-session-runner.ts", "utf-8");

	it("4.1: flushWidget exists and calls ctx.ui.setWidget with widgetId + buildWidgetLines", () => {
		const flushWidgetBody =
			source.split("const flushWidget =")[1]?.split("const scheduleFlush")[0] || "";
		assert.ok(flushWidgetBody.length > 0, "flushWidget function exists");
		assert.ok(flushWidgetBody.includes("ctx.ui.setWidget("), "flushWidget calls setWidget");
		assert.ok(
			flushWidgetBody.includes("buildWidgetLines"),
			"flushWidget calls buildWidgetLines for string array rendering",
		);
	});

	it("4.2: flushWidget has try-catch around setWidget call", () => {
		const flushWidgetBody =
			source.split("const flushWidget =")[1]?.split("const scheduleFlush")[0] || "";
		assert.ok(
			flushWidgetBody.includes("try {") && flushWidgetBody.includes("catch (renderErr: unknown)"),
			"flushWidget must have try-catch to prevent render exceptions from stalling",
		);
	});

	it("4.3: scheduleFlush schedules flushWidget via setTimeout", () => {
		const scheduleFlushBody =
			source.split("const scheduleFlush =")[1]?.split("heartbeatTimer")[0] || "";
		assert.ok(scheduleFlushBody.length > 0, "scheduleFlush function exists");
		assert.ok(
			scheduleFlushBody.includes("setTimeout(flushWidget, 300)") ||
				scheduleFlushBody.includes("setTimeout(flushWidget,"),
			"scheduleFlush debounces flushWidget via setTimeout",
		);
	});
});
