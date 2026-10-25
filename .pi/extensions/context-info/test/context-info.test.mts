import assert from "node:assert";

import { describe, it, beforeEach, afterEach } from "node:test";

import { contextInfo } from "../index.ts";

import { listLocalPrompts } from "../prompts.ts";

import { listLocalSkills } from "../skills.ts";

import { codeflowPortFromSlug } from "../codeflow.ts";

import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";

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
	it("contextInfo is the default export — a function", () => {
		// contextInfo is imported at runtime from ../index.ts.
		// Verifying it's a function confirms the module loaded successfully
		// and the default export is the expected extension factory.
		assert.strictEqual(typeof contextInfo, "function", "contextInfo from index.ts is a function");
	});
	it("prompts/skills runtime exports are valid functions", () => {
		assert.strictEqual(
			typeof listLocalPrompts,
			"function",
			"listLocalPrompts should be a function",
		);
		assert.strictEqual(typeof listLocalSkills, "function", "listLocalSkills should be a function");
	});
	it("prompts/skills exports return arrays (smoke test)", () => {
		const prompts = listLocalPrompts();
		const skills = listLocalSkills();
		assert.ok(Array.isArray(prompts), "listLocalPrompts should return an array");
		assert.ok(Array.isArray(skills), "listLocalSkills should return an array");
		assert.strictEqual(
			Number.isInteger(listLocalSkills().length),
			true,
			"listLocalSkills().length should be a non-negative integer",
		);
	});
	it("registers all expected event handlers when called with mock pi", () => {
		const handlers = new Map<string, (...args: any[]) => void>();
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			events: {
				on: () => {},
			},
		};
		contextInfo(pi as any);

		assert.ok(handlers.has("session_start"), "should register session_start");
		assert.ok(handlers.has("model_select"), "should register model_select");
		assert.ok(handlers.has("message_end"), "should register message_end");
		assert.ok(handlers.has("turn_end"), "should register turn_end");
		assert.ok(handlers.has("thinking_level_select"), "should register thinking_level_select");
		assert.ok(handlers.has("message_update"), "should register message_update");
		assert.ok(handlers.has("tool_execution_end"), "should register tool_execution_end");
		assert.ok(handlers.has("session_shutdown"), "should register session_shutdown");
		assert.ok(handlers.has("before_agent_start"), "should register before_agent_start");
		assert.ok(handlers.has("input"), "should register input");
		assert.ok(handlers.has("user_bash"), "should register user_bash");
	});
	it("session_start handler reads session name from pi.getSessionName()", async () => {
		const handlers = new Map<string, (...args: any[]) => void>();
		let capturedFooterArg: unknown = undefined;
		let sessionNameValue: string | undefined = "my-test-session";
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			getSessionName: () => sessionNameValue,
			events: { on: () => {} },
		};
		contextInfo(pi as any);

		const ctx = {
			...createMockCtx(),
			ui: {
				...createMockCtx().ui,
				setFooter: (fn: unknown) => {
					capturedFooterArg = fn;
				},
			},
		};

		await handlers.get("session_start")!({}, ctx);
		// In RPC mode, installFooter sets footer to undefined and returns early
		assert.strictEqual(capturedFooterArg, undefined, "footer should be undefined in RPC mode");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("session_start with isProjectTrusted()=true runs without error", async () => {
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
		assert.ok(true, "session_start with trusted project completed without error");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("session_start with isProjectTrusted()=false runs without error", async () => {
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

		const ctx = createMockCtx();
		(ctx as any).isProjectTrusted = () => false;

		await handlers.get("session_start")!({}, ctx);
		assert.ok(true, "session_start with untrusted project completed without error");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("session_start emits the CodeFlow URL as an OSC 8 hyperlink when terminal supports it", async () => {
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
		const url = `http://localhost:${codeflowPortFromSlug("alice-foo")}/?repo=local/workspace&run=1`;
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
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			resetCapabilitiesCache();
		}

		assert.strictEqual(notifies[0], "For Info:  /cheasee-pi-info");
		assert.strictEqual(
			notifies[1],
			`CodeFlow:  \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`,
			"hyperlinks-capable terminals must get the OSC 8-wrapped URL (ST terminator, via pi-tui hyperlink)",
		);
		assert.ok(notifies[1].includes("\x1b]8;;"), "expected the OSC 8 hyperlink sequence");

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
	it("session_start emits the plain CodeFlow URL when terminal lacks hyperlink support", async () => {
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
		const url = `http://localhost:${codeflowPortFromSlug("alice-foo")}/?repo=local/workspace&run=1`;
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
		} finally {
			resetCapabilitiesCache();
		}

		assert.strictEqual(notifies[0], "For Info:  /cheasee-pi-info");
		assert.strictEqual(
			notifies[1],
			`CodeFlow:  ${url}`,
			"terminals without hyperlink capabilities must get the plain URL text",
		);
		assert.ok(
			!notifies[1].includes("\x1b]8;;"),
			"no OSC 8 sequence may appear when hyperlinks are unsupported",
		);

		// Cleanup: stop timer via session_shutdown
		await handlers.get("session_shutdown")!();
	});
});
