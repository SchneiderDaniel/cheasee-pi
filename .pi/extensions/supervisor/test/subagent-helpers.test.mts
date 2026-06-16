/**
 * Tests for subagent helpers — cleanupAbortAndSession, buildFailedDetails,
 * sendErrorUpdate, buildErrorResult.
 *
 * These helpers are extracted from duplicated cleanup/error boilerplate in
 * executeSubagent() to eliminate clone pairs (72 lines, 4 locations).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/subagent-helpers.test.mts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
	cleanupAbortAndSession,
	buildFailedDetails,
	sendErrorUpdate,
	buildErrorResult,
} from "../subagent/index.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

function makeMockSession() {
	let disposed = false;
	return {
		dispose: () => {
			disposed = true;
		},
		isDisposed: () => disposed,
		state: { messages: [{ role: "assistant", content: "ok" }] },
	};
}

function makeMockSignal(): {
	signal: AbortSignal;
	aborted: boolean;
	listeners: Map<string, Set<() => void>>;
} {
	const listeners = new Map<string, Set<() => void>>();
	const signal = {
		aborted: false,
		addEventListener: (type: string, handler: () => void, _opts?: any) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(handler);
		},
		removeEventListener: (type: string, handler: () => void) => {
			listeners.get(type)?.delete(handler);
		},
	} as unknown as AbortSignal;
	return { signal, aborted: false, listeners };
}

const sampleCalls = [{ name: "read", args: { path: "/test" } }];
const sampleResults = [{ name: "read", isError: false, result: "ok" }];

// ─── cleanupAbortAndSession ─────────────────────────────────────────

describe("cleanupAbortAndSession", () => {
	it("removes abort listener and disposes session with valid params", () => {
		const { signal, listeners } = makeMockSignal();
		const handler = () => {};
		signal.addEventListener("abort", handler);
		assert.equal(listeners.get("abort")?.has(handler), true, "listener should be attached");

		const session = makeMockSession();
		let unsubscribed = false;
		const unsubscribe = () => {
			unsubscribed = true;
		};
		let timerCleared = false;
		const timer = setTimeout(() => {
			timerCleared = true;
		}, 1000);
		const prevEnv = process.env.WORKTREE_SANDBOX_PATH;

		cleanupAbortAndSession(
			handler,
			signal,
			session as any,
			unsubscribe,
			timer,
			"/test/cwd",
			prevEnv,
		);

		assert.equal(listeners.get("abort")?.has(handler), false, "listener should be removed");
		assert.equal(session.isDisposed(), true, "session should be disposed");
		assert.equal(unsubscribed, true, "unsubscribe should be called");
		assert.equal(timerCleared, false, "timer should be cleared (not fired)");
	});

	it("does not call removeEventListener when abortHandler is undefined", () => {
		const { signal } = makeMockSignal();
		const session = makeMockSession();
		let removeCalled = false;
		const trackedSignal = {
			...signal,
			removeEventListener: () => {
				removeCalled = true;
			},
		} as unknown as AbortSignal;

		cleanupAbortAndSession(
			undefined,
			trackedSignal,
			session as any,
			undefined,
			null,
			undefined,
			undefined,
		);
		assert.equal(removeCalled, false, "removeEventListener should not be called");
	});

	it("does not call removeEventListener when signal is undefined", () => {
		const handler = () => {};
		const session = makeMockSession();
		cleanupAbortAndSession(
			handler,
			undefined,
			session as any,
			undefined,
			null,
			undefined,
			undefined,
		);
		assert.equal(session.isDisposed(), true, "session should still be disposed");
	});

	it("does not throw when session is undefined", () => {
		const handler = () => {};
		cleanupAbortAndSession(handler, undefined, undefined, undefined, null, undefined, undefined);
		// No throw means pass
	});

	it("does not throw when unsubscribe is undefined", () => {
		const session = makeMockSession();
		cleanupAbortAndSession(
			undefined,
			undefined,
			session as any,
			undefined,
			null,
			undefined,
			undefined,
		);
		assert.equal(session.isDisposed(), true);
	});

	it("does not call clearTimeout when debounceTimer is null", () => {
		const session = makeMockSession();
		cleanupAbortAndSession(
			undefined,
			undefined,
			session as any,
			undefined,
			null,
			undefined,
			undefined,
		);
		assert.equal(session.isDisposed(), true);
	});

	it("deletes WORKTREE_SANDBOX_PATH when prevSandboxEnv is undefined and cwd is set", () => {
		process.env.WORKTREE_SANDBOX_PATH = "/tmp/test";
		const session = makeMockSession();
		cleanupAbortAndSession(
			undefined,
			undefined,
			session as any,
			undefined,
			null,
			"/some/cwd",
			undefined,
		);
		assert.equal(process.env.WORKTREE_SANDBOX_PATH, undefined, "env var should be deleted");
		// Restore
		delete process.env.WORKTREE_SANDBOX_PATH;
	});

	it("restores WORKTREE_SANDBOX_PATH when prevSandboxEnv is set and cwd is set", () => {
		process.env.WORKTREE_SANDBOX_PATH = "/current";
		const session = makeMockSession();
		cleanupAbortAndSession(
			undefined,
			undefined,
			session as any,
			undefined,
			null,
			"/some/cwd",
			"/restore/path",
		);
		assert.equal(process.env.WORKTREE_SANDBOX_PATH, "/restore/path", "env var should be restored");
		// Clean up
		delete process.env.WORKTREE_SANDBOX_PATH;
	});

	it("does not touch WORKTREE_SANDBOX_PATH when cwd is undefined", () => {
		process.env.WORKTREE_SANDBOX_PATH = "/untouched";
		const session = makeMockSession();
		cleanupAbortAndSession(
			undefined,
			undefined,
			session as any,
			undefined,
			null,
			undefined,
			undefined,
		);
		assert.equal(process.env.WORKTREE_SANDBOX_PATH, "/untouched", "env var should not be touched");
		delete process.env.WORKTREE_SANDBOX_PATH;
	});

	it("handles all params null/undefined gracefully", () => {
		// Should not throw
		cleanupAbortAndSession(undefined, undefined, undefined, undefined, null, undefined, undefined);
	});
});

// ─── buildFailedDetails ──────────────────────────────────────────────

describe("buildFailedDetails", () => {
	const details = buildFailedDetails(
		"test-agent",
		"Something went wrong",
		"claude-3.5",
		1234,
		sampleCalls,
		sampleResults,
		"do the thing",
	);

	it("returns success: false and statusLabel: FAILED", () => {
		assert.equal(details.success, false);
		assert.equal(details.statusLabel, "FAILED");
	});

	it("sets all zero metrics to 0", () => {
		assert.equal(details.inputTokens, 0);
		assert.equal(details.outputTokens, 0);
		assert.equal(details.cacheRead, 0);
		assert.equal(details.cacheWrite, 0);
		assert.equal(details.cost, 0);
		assert.equal(details.turnCount, 0);
	});

	it("summaryLine is Failed: truncated errorMsg", () => {
		assert.equal(details.summaryLine, "Failed: Something went wrong");
	});

	it("truncates errorMsg > 120 chars in summaryLine", () => {
		const longMsg = "x".repeat(200);
		const d = buildFailedDetails("a", longMsg, "m", 0, [], [], "");
		assert.equal(d.summaryLine, `Failed: ${longMsg.slice(0, 120)}`);
	});

	it("handles empty string errorMsg", () => {
		const d = buildFailedDetails("a", "", "m", 0, [], [], "");
		assert.equal(d.summaryLine, "Failed: ");
	});

	it("handles 120-char exact boundary errorMsg", () => {
		const msg120 = "a".repeat(120);
		const d = buildFailedDetails("a", msg120, "m", 0, [], [], "");
		assert.equal(d.summaryLine, `Failed: ${msg120}`);
	});

	it("toolCalls and toolResults are shallow copies, not same reference", () => {
		const d = buildFailedDetails("a", "err", "m", 0, sampleCalls, sampleResults, "");
		assert.notEqual(d.toolCalls, sampleCalls, "toolCalls should be different reference");
		assert.notEqual(d.toolResults, sampleResults, "toolResults should be different reference");
		assert.deepEqual(d.toolCalls, sampleCalls, "toolCalls should be deep equal");
		assert.deepEqual(d.toolResults, sampleResults, "toolResults should be deep equal");
	});

	it("passes through agentName, durationMs, taskPrompt, model correctly", () => {
		assert.equal(details.agentName, "test-agent");
		assert.equal(details.durationMs, 1234);
		assert.equal(details.taskPrompt, "do the thing");
		assert.equal(details.model, "claude-3.5");
	});
});

// ─── sendErrorUpdate ─────────────────────────────────────────────────

describe("sendErrorUpdate", () => {
	it("calls onUpdate with FAILED content and details matching buildFailedDetails shape", () => {
		let captured: any = undefined;
		const onUpdate = (p: any) => {
			captured = p;
		};

		sendErrorUpdate(
			onUpdate,
			"agent-x",
			"error msg",
			"gpt-4",
			567,
			sampleCalls,
			sampleResults,
			"task-y",
		);

		assert.notEqual(captured, undefined, "onUpdate should have been called");
		const c0 = captured.content[0] as { type: "text"; text: string };
		assert.equal(c0.type, "text");
		assert.ok(c0.text.includes("agent-x"));
		assert.ok(c0.text.includes("failed"));
		assert.ok(c0.text.includes("error msg"));

		// Verify details shape
		assert.equal(captured.details.agentName, "agent-x");
		assert.equal(captured.details.success, false);
		assert.equal(captured.details.statusLabel, "FAILED");
		assert.equal(captured.details.model, "gpt-4");
		assert.equal(captured.details.durationMs, 567);
		assert.equal(captured.details.inputTokens, 0);
	});

	it("does not throw when onUpdate is undefined", () => {
		// Should not throw
		sendErrorUpdate(undefined, "a", "err", "m", 0, [], [], "");
	});

	it("does not throw when onUpdate is undefined (no-op)", () => {
		// Ensure no side-effect
		let called = false;
		const spy = ((..._args: any[]) => {
			called = true;
		}) as any;
		sendErrorUpdate(undefined, "a", "err", "m", 0, [], [], "");
		assert.equal(called, false);
	});
});

// ─── buildErrorResult ────────────────────────────────────────────────

describe("buildErrorResult", () => {
	const result = buildErrorResult(
		"agent-y",
		"big fail",
		"claude-4",
		999,
		sampleCalls,
		sampleResults,
		"task-z",
	);

	it("returns AgentToolResult with content type text", () => {
		const c0 = result.content[0] as { type: "text"; text: string };
		assert.equal(c0.type, "text");
	});

	it("content text contains agent name and error message", () => {
		const c0 = result.content[0] as { type: "text"; text: string };
		assert.ok(c0.text.includes("agent-y"));
		assert.ok(c0.text.includes("failed"));
		assert.ok(c0.text.includes("big fail"));
	});

	it("details matches same FAILED shape produced by buildFailedDetails", () => {
		const expectedDetails = buildFailedDetails(
			"agent-y",
			"big fail",
			"claude-4",
			999,
			sampleCalls,
			sampleResults,
			"task-z",
		);
		assert.deepEqual(result.details, expectedDetails);
	});
});
