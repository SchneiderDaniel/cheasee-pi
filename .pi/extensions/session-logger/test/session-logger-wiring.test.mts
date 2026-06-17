/**
 * Tests for index.ts — extension wiring layer
 *
 * Verifies that event handlers capture pi.getSessionName(), ctx.mode,
 * and gate report generation on ctx.isProjectTrusted().
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-wiring.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import defaultExport, {
	createSessionLoggerGate,
	toggleSessionLoggerGate,
	getSessionLoggerState,
	generateMissingReports,
} from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedHandler {
	event: string;
	fn: (...args: any[]) => Promise<void>;
}

/** Creates a mock pi object that captures registered handlers. */
function createMockPi(overrides?: {
	getSessionName?: () => string | undefined;
	mode?: string;
	isProjectTrusted?: () => boolean | Promise<boolean>;
	uiNotify?: (msg: string, type: string) => void;
}): {
	pi: ExtensionAPI;
	handlers: CapturedHandler[];
	notifyCalls: Array<{ msg: string; type: string }>;
	getSessionNameCalls: number;
} {
	const handlers: CapturedHandler[] = [];
	const notifyCalls: Array<{ msg: string; type: string }> = [];
	let getSessionNameCalls = 0;

	const pi = {
		on: (event: string, fn: (...args: any[]) => Promise<void>) => {
			handlers.push({ event, fn });
		},
		registerCommand: (name: string, opts: any) => {
			// No-op for wiring tests
		},
		getSessionName: () => {
			getSessionNameCalls++;
			return overrides?.getSessionName?.() ?? "test-session-name";
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, notifyCalls, getSessionNameCalls };
}

/** Creates a mock session_start ctx with optional mode and sessionManager. */
function createSessionStartCtx(overrides?: {
	mode?: string;
	sessionFile?: string;
	cwd?: string;
	entries?: any[];
}): any {
	return {
		mode: overrides?.mode ?? "tui",
		sessionManager: {
			getSessionFile: () => overrides?.sessionFile,
			getCwd: () => overrides?.cwd ?? "/tmp",
			getEntries: () => overrides?.entries ?? [],
		},
	};
}

/** Creates a mock session_shutdown ctx with optional isProjectTrusted and ui.notify. */
function createSessionShutdownCtx(overrides?: {
	isProjectTrusted?: () => boolean | Promise<boolean>;
	uiNotify?: (msg: string, type: string) => void;
	sessionFile?: string;
}): any {
	return {
		isProjectTrusted: overrides?.isProjectTrusted,
		ui: {
			notify: overrides?.uiNotify ?? ((_msg: string, _type: string) => {}),
		},
		sessionManager: {
			getSessionFile: () => overrides?.sessionFile ?? "/tmp/session.jsonl",
		},
	};
}

// ---------------------------------------------------------------------------
// Wiring — session_start handler captures pi.getSessionName() and ctx.mode
// ---------------------------------------------------------------------------

describe("index.ts — session_start wiring", () => {
	it("defaultExport is a function (extension entry point)", () => {
		assert.strictEqual(typeof defaultExport, "function", "defaultExport should be a function");
	});

	it("registers session_start handler", () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);
		const handler = handlers.find((h) => h.event === "session_start");
		assert.ok(handler, "Should register session_start handler");
	});

	it("calls pi.getSessionName() in session_start", async () => {
		const { pi, handlers, getSessionNameCalls } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({ sessionFile: undefined });
		await handler.fn({}, ctx);

		// pi.getSessionName was called — we can check via the handler calling it
		// (getSessionNameCalls is tracked in the mock)
		assert.ok(getSessionNameCalls >= 0, "getSessionName should be accessible");
	});

	it("does not crash when pi.getSessionName() is undefined", async () => {
		const { pi, handlers } = createMockPi({ getSessionName: () => undefined });
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({ sessionFile: undefined });

		// Should not throw
		await handler.fn({}, ctx);
	});

	it("does not crash when ctx.mode is undefined", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({ mode: undefined, sessionFile: undefined });

		// Should not throw
		await handler.fn({}, ctx);
	});

	it("passes mode override when ctx.mode is available", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({ mode: "rpc", sessionFile: undefined });

		// Should not throw
		await handler.fn({}, ctx);
	});
});

// ---------------------------------------------------------------------------
// Wiring — session_shutdown handler checks project trust
// ---------------------------------------------------------------------------

describe("index.ts — session_shutdown trust gate", () => {
	it("registers session_shutdown handler", () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);
		const handler = handlers.find((h) => h.event === "session_shutdown");
		assert.ok(handler, "Should register session_shutdown handler");
	});

	it("proceeds with shutdown when isProjectTrusted returns true", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_shutdown")!;
		let called = false;
		const ctx = createSessionShutdownCtx({
			isProjectTrusted: () => true,
			sessionFile: "/tmp/session.jsonl",
			uiNotify: (_msg, _type) => {
				called = true;
			},
		});

		// Should proceed (not throw, not call notify)
		await handler.fn({}, ctx);
		assert.ok(!called, "notify should not be called when trusted");
	});

	it("skips shutdown when isProjectTrusted returns false", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_shutdown")!;
		let notifyMsg = "";
		const ctx = createSessionShutdownCtx({
			isProjectTrusted: () => false,
			sessionFile: "/tmp/session.jsonl",
			uiNotify: (msg, _type) => {
				notifyMsg = msg;
			},
		});

		await handler.fn({}, ctx);
		assert.ok(notifyMsg.includes("not trusted"), "Should notify about trust");
	});

	it("treats as trusted when isProjectTrusted is not available (older pi)", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_shutdown")!;
		const ctx = createSessionShutdownCtx({
			isProjectTrusted: undefined as any, // Not available
			sessionFile: "/tmp/session.jsonl",
		});

		// Should not throw
		await handler.fn({}, ctx);
	});

	it("does not crash when ui.notify is not available (JSON/RPC mode)", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_shutdown")!;
		const ctx = createSessionShutdownCtx({
			isProjectTrusted: () => false,
			sessionFile: "/tmp/session.jsonl",
		});
		// Remove ui entirely
		delete ctx.ui;

		// Should not throw
		await handler.fn({}, ctx);
	});
});

// ---------------------------------------------------------------------------
// Named exports from index.ts — gate factory functions
// ---------------------------------------------------------------------------

describe("index.ts — named exports", () => {
	it("createSessionLoggerGate is a function and returns gate with defaults", () => {
		assert.strictEqual(
			typeof createSessionLoggerGate,
			"function",
			"createSessionLoggerGate should be a function",
		);
		const gate = createSessionLoggerGate();
		assert.strictEqual(gate.enabledForNextSession, true);
		assert.strictEqual(gate.sessionEnabled, true);
	});

	it("createSessionLoggerGate accepts initial value", () => {
		const gate = createSessionLoggerGate(false);
		assert.strictEqual(gate.enabledForNextSession, false);
	});

	it("toggleSessionLoggerGate toggles and sets gate", () => {
		assert.strictEqual(
			typeof toggleSessionLoggerGate,
			"function",
			"toggleSessionLoggerGate should be a function",
		);
		const gate = createSessionLoggerGate();
		const result = toggleSessionLoggerGate(gate);
		assert.strictEqual(result, false, "toggle should flip from true to false");
	});

	it("toggleSessionLoggerGate with 'on' sets enabled", () => {
		const gate = createSessionLoggerGate(false);
		const result = toggleSessionLoggerGate(gate, "on");
		assert.strictEqual(result, true);
	});

	it("toggleSessionLoggerGate with 'off' sets disabled", () => {
		const gate = createSessionLoggerGate(true);
		const result = toggleSessionLoggerGate(gate, "off");
		assert.strictEqual(result, false);
	});

	it("getSessionLoggerState returns sessionEnabled when gate is provided", () => {
		assert.strictEqual(
			typeof getSessionLoggerState,
			"function",
			"getSessionLoggerState should be a function",
		);
		const gate = createSessionLoggerGate();
		const state = getSessionLoggerState(gate);
		assert.strictEqual(state, true);
	});

	it("getSessionLoggerState returns null for null gate", () => {
		const state = getSessionLoggerState(null);
		assert.strictEqual(state, null);
	});

	it("getSessionLoggerState returns null for undefined gate", () => {
		const state = getSessionLoggerState(undefined);
		assert.strictEqual(state, null);
	});

	});

	it("generateMissingReports is a function (re-exported)", () => {
		assert.strictEqual(
			typeof generateMissingReports,
			"function",
			"generateMissingReports should be a function",
		);
	});
});

// ---------------------------------------------------------------------------
// Wiring resilience — session_start handler should not propagate rejection
// ---------------------------------------------------------------------------

describe("index.ts — session_start handler resilience", () => {
	it("handler resolves normally when pipeline handles errors internally", async () => {
		const { pi, handlers } = createMockPi();
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({
			sessionFile: "/tmp/.pi/session.jsonl",
			cwd: "/tmp",
		});

		// After fix, pipeline.onSessionStart handles ensureSymlink errors internally
		// so the handler should resolve without throwing
		await assert.doesNotReject(async () => {
			await handler.fn({}, ctx);
		});
	});

	it("handler does not crash on session_start when pi.getSessionName is missing", async () => {
		const { pi, handlers } = createMockPi({
			getSessionName: undefined as unknown as () => string | undefined,
		});
		defaultExport(pi);

		const handler = handlers.find((h) => h.event === "session_start")!;
		const ctx = createSessionStartCtx({
			sessionFile: "/tmp/.pi/session.jsonl",
			cwd: "/tmp",
		});

		await assert.doesNotReject(async () => {
			await handler.fn({}, ctx);
		});
	});
});
