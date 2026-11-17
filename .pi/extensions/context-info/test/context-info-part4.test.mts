import assert from "node:assert";

import { computeCacheHitRate } from "../cache-stats.ts";

import { describe, it, beforeEach } from "node:test";

import { formatCacheHitRate } from "../formatting.ts";

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
		// Reset the whole cache segment on model change (cache keys are
		// provider/model-specific): counts go with the rate.
		_cacheRead = undefined;
		_cacheWrite = undefined;
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
		// The denominator policy lives in production code (`cache-stats.ts`):
		// cacheRead / (input + cacheRead + cacheWrite). Nothing is written unless
		// a rate is available, so the counts can never drift from the percentage.
		const rate = computeCacheHitRate(usage);
		if (rate !== undefined) {
			_cacheRead = usage.cacheRead;
			_cacheWrite = usage.cacheWrite;
			_cacheHitRate = rate;
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

describe("context-info extension — cache stats capture", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("message_end with input=5000 cacheRead=76288 cacheWrite=0 → captures values", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 5000, cacheRead: 76288, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), 76288);
		assert.strictEqual(getCacheWrite(ctx), 0);
	});

	it("message_end without usage → cacheRead/cacheWrite remain undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", content: [] },
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("message_end with usage but missing cacheRead → cacheRead stays undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { totalTokens: 100, input: 50, output: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("session_start resets cache stats", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 1000, cacheRead: 100, cacheWrite: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), 100);

		// New session resets
		invoke(ctx, "session_start", {});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("message_end role is not assistant → does not capture cache stats", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "user",
				usage: { cacheRead: 100, cacheWrite: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});
});
describe("context-info extension — cache hit rate computation", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("message_end with input=0 cacheRead=76288 cacheWrite=1024 → fully cached read share", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 0, cacheRead: 76288, cacheWrite: 1024 },
			},
		});
		// 76288 / 77312 * 100 = 98.674...
		assert.strictEqual(Math.round(getCacheHitRate(ctx)!), 99);
	});

	it("message_end with input=0 cacheRead=0 cacheWrite=100 → cacheHitRate=0", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 0, cacheRead: 0, cacheWrite: 100 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 0);
	});

	it("message_end with input>0 and cacheWrite=0 → below 100 (not the old CH bug)", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 2000, cacheRead: 100, cacheWrite: 0 },
			},
		});
		const rate = getCacheHitRate(ctx);
		assert.ok(rate !== undefined, "rate must be set");
		assert.ok(rate! < 100, `zero cacheWrite alone must not report 100%, got ${rate}`);
	});

	it("message_end with both cacheRead and cacheWrite undefined → cacheHitRate stays undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});

	it("message_end without usage object → cacheHitRate stays undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", content: "hello" },
		});
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});

	it("message_end with only cacheRead (cacheWrite undefined) → cacheHitRate stays undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 100 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});

	it("model_select resets cacheHitRate to undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 0, cacheRead: 100, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 100);

		// model_select resets the whole cache segment (counts included)
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		assert.strictEqual(getCacheHitRate(ctx), undefined);
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("session_start resets cacheHitRate", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 0, cacheRead: 100, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 100);

		// New session resets
		invoke(ctx, "session_start", {});
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});
});
describe("formatCacheHitRate", () => {
	it("formatCacheHitRate(75) → Cache Hit Rate: 75%", () => {
		assert.strictEqual(formatCacheHitRate(75), "Cache Hit Rate: 75%");
	});

	it("formatCacheHitRate(0) → Cache Hit Rate: 0%", () => {
		assert.strictEqual(formatCacheHitRate(0), "Cache Hit Rate: 0%");
	});

	it("formatCacheHitRate(100) → Cache Hit Rate: 100%", () => {
		assert.strictEqual(formatCacheHitRate(100), "Cache Hit Rate: 100%");
	});

	it("formatCacheHitRate(33.333) → Cache Hit Rate: 33% (rounded integer)", () => {
		assert.strictEqual(formatCacheHitRate(33.333), "Cache Hit Rate: 33%");
	});

	it("formatCacheHitRate(undefined) → label stays visible as unavailable", () => {
		assert.strictEqual(formatCacheHitRate(undefined), "Cache Hit Rate: --");
	});

	it("formatCacheHitRate(null) → label stays visible as unavailable", () => {
		assert.strictEqual(formatCacheHitRate(null as any), "Cache Hit Rate: --");
	});

	it("formatCacheHitRate(NaN) → label stays visible as unavailable", () => {
		assert.strictEqual(formatCacheHitRate(NaN), "Cache Hit Rate: --");
	});
});
describe("context-info extension — mode guard", () => {
	it("session_start with ctx.mode === 'rpc' does not increment UI calls", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.mode = "rpc";
		invoke(ctx, "session_start", { mode: "rpc" });
		// In TUI mode, setFooter would be called; in RPC it should not
		assert.strictEqual(getUiSetFooterCalls(ctx), 0, "should not call UI setFooter in RPC mode");
	});

	it("session_start with ctx.mode === 'tui' does increment UI calls", () => {
		const ctx = createContextInfoExtension();
		ctx.mockCtx.mode = "tui";
		invoke(ctx, "session_start", { mode: "tui" });
		assert.strictEqual(getUiSetFooterCalls(ctx), 1, "should call UI setFooter in TUI mode");
	});

	it("session_start with ctx.mode undefined (backward compat) does increment UI calls", () => {
		const ctx = createContextInfoExtension();
		// mode is undefined by default
		invoke(ctx, "session_start", {});
		assert.strictEqual(
			getUiSetFooterCalls(ctx),
			1,
			"should call UI setFooter when mode is undefined",
		);
	});
});
describe("context-info extension — session name", () => {
	it("session_start calls pi.getSessionName() and stores result", () => {
		const ctx = createContextInfoExtension();
		(ctx.pi as any).getSessionName = () => "my-session";
		invoke(ctx, "session_start", {});
		assert.strictEqual(getSessionName(ctx), "my-session");
	});

	it("session_start with pi.getSessionName() returning undefined → sessionName = undefined", () => {
		const ctx = createContextInfoExtension();
		(ctx.pi as any).getSessionName = () => undefined;
		invoke(ctx, "session_start", {});
		assert.strictEqual(getSessionName(ctx), undefined);
	});

	it("session_start with pi.getSessionName() returning string → sessionName = that string", () => {
		const ctx = createContextInfoExtension();
		(ctx.pi as any).getSessionName = () => "dev-session";
		invoke(ctx, "session_start", {});
		assert.strictEqual(getSessionName(ctx), "dev-session");
	});

	it("model_select re-reads pi.getSessionName() → picks up mid-session rename", () => {
		const ctx = createContextInfoExtension();
		(ctx.pi as any).getSessionName = () => "original-name";
		invoke(ctx, "session_start", {});

		// Mid-session rename
		(ctx.pi as any).getSessionName = () => "renamed-session";
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });

		assert.strictEqual(getSessionName(ctx), "renamed-session");
	});

	it("turn_end re-reads pi.getSessionName() → picks up mid-session rename", () => {
		const ctx = createContextInfoExtension();
		(ctx.pi as any).getSessionName = () => "original-name";
		invoke(ctx, "session_start", {});

		// Mid-session rename
		(ctx.pi as any).getSessionName = () => "renamed-session";
		invoke(ctx, "turn_end", {});

		assert.strictEqual(getSessionName(ctx), "renamed-session");
	});
});
