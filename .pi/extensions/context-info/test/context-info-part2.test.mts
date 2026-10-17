import assert from "node:assert";

import { describe, it, beforeEach, afterEach } from "node:test";

import { contextInfo } from "../index.ts";

import { promptsLocator, promptsNameOf } from "../prompts.ts";

import { listMarkdownResources } from "../markdown-resources.ts";

import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { execSync } from "node:child_process";

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

describe("contextInfo from index.ts", () => {
	beforeEach(() => {
		delete process.env.CODEFLOW_PORT;
		delete process.env.PI_UI_PORT;
		delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
	});
	afterEach(() => {
		delete process.env.CODEFLOW_PORT;
		delete process.env.PI_UI_PORT;
		delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
	});
	function createMockCtx() {
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
	function makeCodeflowWorkspace(): { root: string; parent: string } {
		const parent = mkdtempSync(join(tmpdir(), "codeflow-hint-"));
		const root = join(parent, "ws");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "cheasee-settings.json"), "{}");
		const bare = join(parent, ".bare");
		mkdirSync(bare, { recursive: true });
		execSync(`git --git-dir "${bare}" init --bare`, { stdio: "ignore" });
		execSync(`git --git-dir "${bare}" config remote.origin.url "git@github.com:alice/foo.git"`, {
			stdio: "ignore",
		});
		return { root, parent };
	}
	it("session_start degrades gracefully when the CodeFlow URL is unresolvable", async () => {
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

		const notifies: string[] = [];
		const ctx = {
			...createMockCtx(),
			cwd: mkdtempSync(join(tmpdir(), "codeflow-unresolvable-")), // outside any workspace marker
			ui: {
				...createMockCtx().ui,
				notify: (msg: string) => {
					notifies.push(msg);
				},
			},
		};

		await handlers.get("session_start")!({}, ctx);
		assert.strictEqual(
			notifies.length,
			1,
			"unresolvable workspace must emit only the For Info hint",
		);
		assert.strictEqual(notifies[0], "For Info:  /cheasee-pi-info");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("repeated session_start re-emits the CodeFlow notify without duplicate-row or throw behavior", async () => {
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

		const { root } = makeCodeflowWorkspace();
		const notifies: string[] = [];
		const ctx = {
			...createMockCtx(),
			cwd: root,
			ui: {
				...createMockCtx().ui,
				notify: (msg: string) => {
					notifies.push(msg);
				},
			},
		};

		try {
			setCapabilities({ hyperlinks: false, images: null, trueColor: false });
			await handlers.get("session_start")!({}, ctx);
			await handlers.get("session_start")!({}, ctx);
		} finally {
			resetCapabilitiesCache();
		}

		assert.strictEqual(
			notifies.length,
			4,
			"two session_starts must emit 2 For Info + 2 CodeFlow notifies",
		);
		assert.ok(notifies[1].startsWith("CodeFlow:  "), "first CodeFlow notify present");
		assert.ok(notifies[3].startsWith("CodeFlow:  "), "second CodeFlow notify present");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("model_select handler does not throw", async () => {
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

		await handlers.get("session_start")!({}, createMockCtx());
		await handlers.get("model_select")!({ model: { contextWindow: 256000 } }, createMockCtx());
		assert.ok(true, "model_select completed without error");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("message_end handler does not throw with cache stats", async () => {
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

		const ctx = {
			...createMockCtx(),
			getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }),
		};
		await handlers.get("session_start")!({}, ctx);

		await handlers.get("message_end")!(
			{ message: { role: "assistant", usage: { cacheRead: 76288, cacheWrite: 1024 } } },
			ctx,
		);
		assert.ok(true, "message_end with cache stats completed without error");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("turn_end handler does not throw", async () => {
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

		await handlers.get("session_start")!({}, createMockCtx());
		await handlers.get("turn_end")!({}, createMockCtx());
		assert.ok(true, "turn_end completed without error");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
});
describe("listMarkdownResources — prompts locator", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctxt-info-pr-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns .md files in subdirectory and top-level", () => {
		writeFileSync(join(tmpDir, "readme.md"), "---\ndescription: Top-level\n---\nContent");
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "guide.md"), "---\ndescription: Subdir guide\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: promptsLocator,
			nameOf: promptsNameOf,
		});

		assert.strictEqual(result.length, 2, "should find 2 .md files");
		// Sorted by name: guide, readme
		assert.strictEqual(result[0]!.name, "guide");
		assert.strictEqual(result[0]!.description, "Subdir guide");
		assert.strictEqual(result[1]!.name, "readme");
		assert.strictEqual(result[1]!.description, "Top-level");
	});

	it("skips non-.md files in subdirectories", () => {
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "readme.txt"), "not markdown");
		writeFileSync(join(subDir, "notes.md"), "---\ndescription: Notes\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: promptsLocator,
			nameOf: promptsNameOf,
		});

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.name, "notes");
	});

	it("returns empty array for empty directory", () => {
		const result = listMarkdownResources({
			dir: tmpDir,
			locate: promptsLocator,
			nameOf: promptsNameOf,
		});
		assert.strictEqual(result.length, 0);
	});

	it("returns empty array for missing directory", () => {
		const result = listMarkdownResources({
			dir: join(tmpDir, "nonexistent"),
			locate: promptsLocator,
			nameOf: promptsNameOf,
		});
		assert.strictEqual(result.length, 0);
	});

	it("maintains sort order (case-insensitive)", () => {
		writeFileSync(join(tmpDir, "alpha.md"), "---\ndescription: A\n---\nContent");
		writeFileSync(join(tmpDir, "Beta.md"), "---\ndescription: B\n---\nContent");
		writeFileSync(join(tmpDir, "gamma.md"), "---\ndescription: G\n---\nContent");

		const result = listMarkdownResources({
			dir: tmpDir,
			locate: promptsLocator,
			nameOf: promptsNameOf,
		});

		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0]!.name, "alpha");
		assert.strictEqual(result[1]!.name, "Beta");
		assert.strictEqual(result[2]!.name, "gamma");
	});
});
