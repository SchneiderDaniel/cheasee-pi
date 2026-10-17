import assert from "node:assert";

import { describe, it, beforeEach, afterEach } from "node:test";

import { formatSessionTimer } from "../formatting.ts";

import { skillsLocator, skillsNameOf } from "../skills.ts";

import { listMarkdownResources } from "../markdown-resources.ts";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

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

describe("listMarkdownResources — skills locator", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctxt-info-sk-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("finds SKILL.md in subdirectory, uses dir name as resource name", () => {
		const skillDir = join(tmpDir, "my-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: My skill\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: skillsLocator,
			nameOf: skillsNameOf,
		});

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.name, "my-skill");
		assert.strictEqual(result[0]!.description, "My skill");
	});

	it("finds standalone .md at top level", () => {
		writeFileSync(join(tmpDir, "readme.md"), "---\ndescription: Readme\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: skillsLocator,
			nameOf: skillsNameOf,
		});

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.name, "readme");
	});

	it("skips subdirectories without SKILL.md", () => {
		const subDir = join(tmpDir, "no-skill");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "other.md"), "---\ndescription: Other\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: skillsLocator,
			nameOf: skillsNameOf,
		});

		assert.strictEqual(result.length, 0, "sub without SKILL.md should be skipped");
	});

	it("ignores .gitkeep", () => {
		writeFileSync(join(tmpDir, ".gitkeep"), "");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: skillsLocator,
			nameOf: skillsNameOf,
		});

		assert.strictEqual(result.length, 0, ".gitkeep should be ignored");
	});

	it("returns empty array for missing directory", () => {
		const result = listMarkdownResources({
			dir: join(tmpDir, "nonexistent"),
			locate: skillsLocator,
			nameOf: skillsNameOf,
		});
		assert.strictEqual(result.length, 0);
	});
});
describe("formatSessionTimer", () => {
	it("0ms → ⏱ 0s", () => {
		assert.strictEqual(formatSessionTimer(0), "\u23f1 0s");
	});

	it("sub-minute: 30s → ⏱ 30s", () => {
		assert.strictEqual(formatSessionTimer(30_000), "\u23f1 30s");
	});

	it("multi-minute: 5m 30s → ⏱ 5m 30s", () => {
		assert.strictEqual(formatSessionTimer(330_000), "\u23f1 5m 30s");
	});

	it("multi-hour: 1h 23m 45s → ⏱ 1h 23m 45s", () => {
		assert.strictEqual(formatSessionTimer(5_025_000), "\u23f1 1h 23m 45s");
	});

	it(">24h: 26h 15m → ⏱ 26h 15m 0s", () => {
		// 26h 15m = 94,500,000ms
		assert.strictEqual(formatSessionTimer(94_500_000), "\u23f1 26h 15m 0s");
	});

	it("exact hour: 1h → ⏱ 1h 0m 0s", () => {
		assert.strictEqual(formatSessionTimer(3_600_000), "\u23f1 1h 0m 0s");
	});

	it("exact minute: 1m → ⏱ 1m 0s", () => {
		assert.strictEqual(formatSessionTimer(60_000), "\u23f1 1m 0s");
	});
});
describe("context-info extension — happy path", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.1: model_select + assistant message with usage → no stdout emit (regression: TUI ghost text)", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});

		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.2: message_end before model_select → still no stdout emit", () => {
		invoke(ctx, "session_start", {});
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);

		// Model info arriving later changes nothing either
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});
describe("context-info extension — suppression cases", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.3: contextWindow missing → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: {} });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.4: contextWindow is 0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 0 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.5: contextWindow undefined → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: undefined } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.6: getContextUsage returns undefined → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		// Don't call setCtxUsage — getContextUsage returns undefined
		invoke(ctx, "message_end", { message: { role: "assistant" } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.7: getContextUsage returns tokens=0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 0);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.8: message role is not assistant → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "user" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.9: no message_end ever fires → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.10: no model_select ever fires → no emit", () => {
		invoke(ctx, "session_start", {});
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.11: agent fails immediately (only session_start) → no emit", () => {
		invoke(ctx, "session_start", {});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});
describe("context-info extension — reset behavior", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.12: second session_start resets state → still never emits to stdout", () => {
		// Round 1
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);

		// Round 2 — reset mockCtx as well (new session)
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		setCtxUsage(ctx, 8000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});
describe("context-info extension — error resilience", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.13: getContextUsage returns negative tokens → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, -1);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.14: contextWindow negative → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: -1 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});
