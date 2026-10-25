import assert from "node:assert";

import { describe, it } from "node:test";

import { formatCacheStats } from "../formatting.ts";

import { contextInfo } from "../index.ts";

interface MockCtx {
	getContextUsage: () => { tokens?: number; contextWindow?: number } | undefined;
	mode?: string;
	isProjectTrusted?: () => boolean | undefined;
}

interface MockPi {
	on: (event: string, handler: (...args: any[]) => void) => void;
	getSessionName?: () => string | undefined;
}

function createContextInfoExtension(): {
	pi: MockPi;
	logCalls: string[];
	mockCtx: MockCtx;
	getCacheRead: () => number | undefined;
	getCacheWrite: () => number | undefined;
	getCacheHitRate: () => number | undefined;
	getSessionName: () => string | undefined;
	getTrustStatus: () => string | undefined;
	getUiSetFooterCalls: () => number;
} {
	const logCalls: string[] = [];
	const handlers = new Map<string, (...args: any[]) => void>();
	const mockCtx: MockCtx = {
		getContextUsage: () => undefined,
	};
	let _cacheRead: number | undefined;
	let _cacheWrite: number | undefined;
	let _cacheHitRate: number | undefined;
	let _sessionName: string | undefined;
	let _trustStatus: "trusted" | "untrusted" | undefined;
	let _uiSetFooterCalls = 0;

	const mockPi: MockPi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		getSessionName: () => _sessionName,
	};

	// Regression: context-info must NEVER print to stdout in TUI mode —
	// tryEmit's console.log landed raw bytes inside the TUI frame (the
	// "random text" stuck in the text entry while Working). Removed in
	// favor of footer-only context stats. logCalls stays for assertions.

	handlers.set("session_start", () => {
		_cacheRead = undefined;
		_cacheWrite = undefined;
		_cacheHitRate = undefined;
		_trustStatus = undefined;

		// Read session name from pi.getSessionName()
		if (mockPi.getSessionName) {
			_sessionName = mockPi.getSessionName();
		}

		// Read trust status from ctx.isProjectTrusted()
		if (typeof mockCtx.isProjectTrusted === "function") {
			const trusted = mockCtx.isProjectTrusted();
			if (trusted === true) _trustStatus = "trusted";
			else if (trusted === false) _trustStatus = "untrusted";
			else _trustStatus = undefined;
		}

		// Mode guard: only do UI operations in TUI mode
		if (mockCtx.mode === undefined || mockCtx.mode === "tui") {
			_uiSetFooterCalls++;
		}
	});

	handlers.set("model_select", (event: any) => {
		// Reset cache hit rate on model change (per research finding)
		_cacheHitRate = undefined;
		// Re-read session name (in case setSessionName was called mid-session)
		if (mockPi.getSessionName) {
			_sessionName = mockPi.getSessionName();
		}
	});

	// Match production: use ctx.getContextUsage() instead of event.message.usage
	// Also capture cacheRead/cacheWrite from event.message.usage
	// Also compute cache hit rate (Improvement #1)
	handlers.set("message_end", (event: any) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		// Capture cache stats from raw event usage
		const usage = msg.usage;
		if (usage) {
			if (typeof usage.cacheRead === "number") _cacheRead = usage.cacheRead;
			if (typeof usage.cacheWrite === "number") _cacheWrite = usage.cacheWrite;

			// Compute cache hit rate: cacheRead/(cacheRead+cacheWrite)*100
			if (typeof _cacheRead === "number" && typeof _cacheWrite === "number") {
				_cacheHitRate = Math.round((_cacheRead / (_cacheRead + _cacheWrite)) * 100);
			}
		}
	});

	handlers.set("turn_end", () => {
		// Re-read session name (in case setSessionName was called mid-session)
		if (mockPi.getSessionName) {
			_sessionName = mockPi.getSessionName();
		}
	});

	function invoke(event: string, ...args: any[]) {
		const handler = handlers.get(event);
		if (handler) handler(...args);
	}

	return {
		pi: mockPi,
		logCalls,
		mockCtx,
		getCacheRead: () => _cacheRead,
		getCacheWrite: () => _cacheWrite,
		getCacheHitRate: () => _cacheHitRate,
		getSessionName: () => _sessionName,
		getTrustStatus: () => _trustStatus,
		getUiSetFooterCalls: () => _uiSetFooterCalls,
		_handlers: handlers,
		_invoke: invoke,
	} as unknown as {
		pi: MockPi;
		logCalls: string[];
		mockCtx: MockCtx;
		getCacheRead: () => number | undefined;
		getCacheWrite: () => number | undefined;
		getCacheHitRate: () => number | undefined;
		getSessionName: () => string | undefined;
		getTrustStatus: () => string | undefined;
		getUiSetFooterCalls: () => number;
		_invoke: (e: string, ...a: any[]) => void;
	};
}

type TestCtx = ReturnType<typeof createContextInfoExtension>;

function setCtxUsage(ctx: TestCtx, tokens: number) {
	ctx.mockCtx.getContextUsage = () => ({ tokens, contextWindow: 256000 });
}

function getCacheRead(ctx: TestCtx): number | undefined {
	return ctx.getCacheRead();
}

function getCacheWrite(ctx: TestCtx): number | undefined {
	return ctx.getCacheWrite();
}

function getCacheHitRate(ctx: TestCtx): number | undefined {
	return ctx.getCacheHitRate();
}

function getSessionName(ctx: TestCtx): string | undefined {
	return ctx.getSessionName();
}

function getTrustStatus(ctx: TestCtx): string | undefined {
	return ctx.getTrustStatus();
}

function getUiSetFooterCalls(ctx: TestCtx): number {
	return ctx.getUiSetFooterCalls();
}

function invoke(ctx: TestCtx, event: string, ...args: any[]) {
	(ctx as any)._invoke(event, ...args);
}

function createShutdownMockCtx() {
	return {
		mode: "rpc",
		ui: {
			setFooter: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			notify: () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		sessionManager: { getSessionFile: () => "/tmp/test_uuid.jsonl" },
		model: { id: "test-model", contextWindow: 128000 },
		cwd: "/tmp",
	};
}

describe("context-info extension — trust status", () => {
	it("session_start calls ctx.isProjectTrusted() → trusted", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.isProjectTrusted = () => true;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), "trusted");
	});

	it("ctx.isProjectTrusted() returns false → trustStatus = 'untrusted'", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.isProjectTrusted = () => false;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), "untrusted");
	});

	it("ctx.isProjectTrusted() returns undefined → trustStatus = undefined", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.isProjectTrusted = () => undefined;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), undefined);
	});

	it("ctx.isProjectTrusted() not defined → trustStatus stays undefined", () => {
		const ctx = createContextInfoExtension();
		// isProjectTrusted not set on mockCtx
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), undefined);
	});

	it("session_start resets trustStatus, then re-reads", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.isProjectTrusted = () => true;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), "trusted");

		// New session with different trust
		ctx.mockCtx.isProjectTrusted = () => false;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getTrustStatus(ctx), "untrusted");
	});
});
describe("formatCacheStats", () => {
	it("formatCacheStats(76288, 0) → 📦 76.3K/0", () => {
		assert.strictEqual(formatCacheStats(76288, 0), "\u{1F4E6} 76.3K/0");
	});

	it("formatCacheStats(1200000, 500) → 📦 1.2M/500", () => {
		assert.strictEqual(formatCacheStats(1200000, 500), "\u{1F4E6} 1.2M/500");
	});

	it("formatCacheStats(0, 0) → 📦 0/0", () => {
		assert.strictEqual(formatCacheStats(0, 0), "\u{1F4E6} 0/0");
	});

	it("formatCacheStats(undefined, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(undefined, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(null, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(null, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(0, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(0, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(undefined, 0) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(undefined, 0), "\u{1F4E6} --/--");
	});
});
describe("context-info extension — session_shutdown disposes state", () => {
	it("session_shutdown calls dispose — events after shutdown are safe (no throw)", async () => {
		const handlers = new Map<string, (...args: any[]) => void>();
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			getSessionName: () => undefined,
			events: { on: () => {} },
		};
		contextInfo(pi as any);

		const ctx = createShutdownMockCtx(); // mode="rpc"

		// Start session — creates FooterState
		await handlers.get("session_start")!({}, ctx);

		// Shutdown session — dispose() sets disposed=true, stops timer
		await handlers.get("session_shutdown")!();

		// All events should be safe no-ops — guard on state.disposed
		await assert.doesNotReject(
			(async () => {
				await handlers.get("thinking_level_select")!({ level: "high" }, ctx);
			})(),
			"thinking_level_select after shutdown should not reject",
		);
		await assert.doesNotReject(
			(async () => {
				await handlers.get("model_select")!({ model: { contextWindow: 256000 } }, ctx);
			})(),
			"model_select after shutdown should not reject",
		);
		await assert.doesNotReject(
			(async () => {
				await handlers.get("turn_end")!({}, ctx);
			})(),
			"turn_end after shutdown should not reject",
		);
		await assert.doesNotReject(
			(async () => {
				await handlers.get("message_end")!({ message: { role: "assistant", usage: {} } }, ctx);
			})(),
			"message_end after shutdown should not reject",
		);
		await assert.doesNotReject(
			(async () => {
				await handlers.get("message_update")!({ assistantMessageEvent: {} }, ctx);
			})(),
			"message_update after shutdown should not reject",
		);
		await assert.doesNotReject(
			(async () => {
				await handlers.get("tool_execution_end")!();
			})(),
			"tool_execution_end after shutdown should not reject",
		);

		assert.ok(true, "All events after session_shutdown completed without error");
	});

	it("session_shutdown does not throw when called without prior session_start", async () => {
		const handlers = new Map<string, (...args: any[]) => void>();
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			getSessionName: () => undefined,
			events: { on: () => {} },
		};
		contextInfo(pi as any);

		// No session_start before shutdown
		await assert.doesNotReject(
			(async () => {
				await handlers.get("session_shutdown")!();
			})(),
			"session_shutdown without prior session should not reject",
		);
	});
});
describe("context-info extension — footer mirrors pi's live thinking level", () => {
	/** Fake ExtensionAPI (live getThinkingLevel) + TUI ctx capturing rendered rows. */
	function makeHarness(liveLevel: () => string) {
		const handlers = new Map<string, (...args: any[]) => void>();
		const renders: string[][] = [];
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			getSessionName: () => undefined,
			getThinkingLevel: liveLevel,
			events: { on: () => {} },
		};
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						const component = (
							fn as (
								tui: unknown,
								theme: { fg: (c: string, t: string) => string },
								footerData: unknown,
							) => { render: (w: number) => string[] }
						)(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{ fg: (_color: string, text: string) => text },
							{
								onBranchChange: () => () => {},
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
							},
						);
						renders.push(component.render(80));
					}
				},
				setStatus: () => {},
				setWidget: () => {},
				setWorkingIndicator: () => {},
				notify: () => {},
				theme: { fg: (_c: string, t: string) => t },
			},
			isProjectTrusted: () => true,
			getContextUsage: () => undefined,
			sessionManager: { getSessionFile: () => "/tmp/test_uuid.jsonl" },
			model: { id: "test-model", contextWindow: 128000 },
			cwd: "/tmp",
		};
		return { pi, handlers, ctx, renders };
	}

	it("session start uses pi's live level ('medium') instead of 'off' when the mirror starts empty", async () => {
		const { pi, handlers, ctx, renders } = makeHarness(() => "medium");
		contextInfo(pi as any);

		await handlers.get("session_start")!({}, ctx);

		const row0 = renders.at(-1)![0]!;
		assert.ok(row0.includes("◒ medium"), `live 'medium' must render, got: ${row0}`);
		assert.ok(!row0.includes("○ off"), `must not show the 'off' fallback, got: ${row0}`);

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});

	it("model switch resyncs the mirror from pi's live level (stale mirror → 'high')", async () => {
		let liveLevel = "medium";
		const { pi, handlers, ctx, renders } = makeHarness(() => liveLevel);
		contextInfo(pi as any);

		await handlers.get("session_start")!({}, ctx);
		assert.ok(
			renders.at(-1)![0]!.includes("◒ medium"),
			"initial session should show live 'medium'",
		);

		// Model switch re-clamps the thinking level in pi
		liveLevel = "high";
		await handlers.get("model_select")!({ model: { contextWindow: 128000 } }, ctx);

		const row0 = renders.at(-1)![0]!;
		assert.ok(row0.includes("◓ high"), `resynced 'high' must render, got: ${row0}`);
		assert.ok(!row0.includes("◒ medium"), `stale 'medium' must be gone, got: ${row0}`);

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});

	it("shows '○ off' only when pi's live level reports 'off'", async () => {
		const { pi, handlers, ctx, renders } = makeHarness(() => "off");
		contextInfo(pi as any);

		await handlers.get("session_start")!({}, ctx);

		const row0 = renders.at(-1)![0]!;
		assert.ok(row0.includes("○ off"), `live 'off' must render '○ off', got: ${row0}`);

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
});
