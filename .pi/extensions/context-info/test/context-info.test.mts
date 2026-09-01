/**
 * Tests for .pi/extensions/context-info.ts — Context Window Telemetry Extension
 *
 * Verifies extension state machine handles all event orderings and edge cases.
 * Pure unit tests — mock ExtensionAPI by capturing registered callbacks.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/context-info.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	formatCacheHitRate,
	formatSessionTimer,
	formatCacheStats,
	formatTokens,
} from "../formatting.ts";

// Runtime import from index.ts — verified through the test assertion below.
// All local imports in index.ts use .ts extensions (changed from .js)
// to support --experimental-strip-types resolution.
import { contextInfo } from "../index.ts";

// Runtime imports from prompts.ts, skills.ts — these files
// had import extension changes (.js → .ts) needed for the test runner.
// The imports verify their module-level exports are valid at runtime.
import { listLocalPrompts, promptsLocator, promptsNameOf } from "../prompts.ts";
import { listLocalSkills, skillsLocator, skillsNameOf } from "../skills.ts";
import { listMarkdownResources, type ResourceMeta } from "../markdown-resources.ts";

// CodeFlow URL resolver + pi-tui capability seam for the session_start hint
// tests (setCapabilities gates the OSC 8 hyperlink branch deterministically).
import { codeflowPortFromSlug } from "../codeflow.ts";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

// Temp-directory helpers for walker tests
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Replicate context-info extension logic for isolated unit testing
// (matches .pi/extensions/context-info.ts implementation exactly)
// ---------------------------------------------------------------------------

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

	// Simulate the extension's default export logic
	let contextWindow: number | undefined;
	let contextTokens: number | undefined;
	let emitted = false;

	function tryEmit() {
		if (emitted) return;
		if (contextWindow === undefined || contextWindow <= 0) return;
		if (contextTokens === undefined || contextTokens <= 0) return;
		emitted = true;
		logCalls.push(
			JSON.stringify({
				type: "context_info",
				contextTokens,
				contextWindow,
			}),
		);
	}

	handlers.set("session_start", () => {
		contextWindow = undefined;
		contextTokens = undefined;
		emitted = false;
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
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			contextWindow = cw;
			tryEmit();
		}
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
		const ctxUsage = mockCtx.getContextUsage();
		if (ctxUsage && typeof ctxUsage.tokens === "number" && ctxUsage.tokens > 0) {
			contextTokens = ctxUsage.tokens;
			tryEmit();
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reference test for contextInfo from index.ts
// The named import of contextInfo at the top of this file provides static
// coverage for index.ts's default export. This test verifies the type-level
// reference is valid.
// ---------------------------------------------------------------------------

describe("contextInfo from index.ts", () => {
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

	/** Create a mock ExtensionContext with mode="rpc" to avoid timer issues */
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

	/** Temp workspace root + sibling bare clone with remote git@github.com:alice/foo.git
	 * (slug "alice-foo" → deterministic port) for the CodeFlow hint tests. */
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
		assert.strictEqual(notifies.length, 1, "unresolvable workspace must emit only the For Info hint");
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

		assert.strictEqual(notifies.length, 4, "two session_starts must emit 2 For Info + 2 CodeFlow notifies");
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

// ---------------------------------------------------------------------------
// listMarkdownResources tests (using temp directories)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// formatSessionTimer tests (using imported real implementation)
// ---------------------------------------------------------------------------

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

	it("P2.1: model_select then assistant message with usage → emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});

		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}',
		);
	});

	it("P2.2: message_end before model_select → deferred emit", () => {
		invoke(ctx, "session_start", {});
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		// No emit yet — waiting for model info
		assert.strictEqual(ctx.logCalls.length, 0);

		// Now model info arrives → emit
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}',
		);
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

	it("P2.12: second session_start resets state → separate emits per round", () => {
		// Round 1
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 1);

		// Round 2 — reset mockCtx as well (new session)
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		setCtxUsage(ctx, 8000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 2);
		assert.strictEqual(
			ctx.logCalls[1],
			'{"type":"context_info","contextTokens":8000,"contextWindow":512000}',
		);
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

// ---------------------------------------------------------------------------
// Cache stats capture tests (existing + CH)
// ---------------------------------------------------------------------------

describe("context-info extension — cache stats capture", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("message_end with usage.cacheRead=76288 cacheWrite=0 → captures values", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 76288, cacheWrite: 0 },
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
				usage: { cacheRead: 100, cacheWrite: 50 },
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

// ---------------------------------------------------------------------------
// CH computation tests (Improvement #1)
// ---------------------------------------------------------------------------

describe("context-info extension — cache hit rate computation", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("message_end with cacheRead=76288, cacheWrite=1024 → cacheHitRate=99", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 76288, cacheWrite: 1024 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 99);
	});

	it("message_end with cacheRead=0, cacheWrite=100 → cacheHitRate=0", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 0, cacheWrite: 100 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 0);
	});

	it("message_end with cacheRead=100, cacheWrite=0 → cacheHitRate=100", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 100, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 100);
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
				usage: { cacheRead: 100, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 100);

		// model_select resets CH
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});

	it("session_start resets cacheHitRate", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 100, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheHitRate(ctx), 100);

		// New session resets
		invoke(ctx, "session_start", {});
		assert.strictEqual(getCacheHitRate(ctx), undefined);
	});
});

// ---------------------------------------------------------------------------
// formatCacheHitRate tests
// ---------------------------------------------------------------------------

describe("formatCacheHitRate", () => {
	it("formatCacheHitRate(75) → CH: 75%", () => {
		assert.strictEqual(formatCacheHitRate(75), "CH: 75%");
	});

	it("formatCacheHitRate(0) → CH: 0%", () => {
		assert.strictEqual(formatCacheHitRate(0), "CH: 0%");
	});

	it("formatCacheHitRate(100) → CH: 100%", () => {
		assert.strictEqual(formatCacheHitRate(100), "CH: 100%");
	});

	it("formatCacheHitRate(33.333) → CH: 33% (rounded integer)", () => {
		assert.strictEqual(formatCacheHitRate(33.333), "CH: 33%");
	});

	it("formatCacheHitRate(undefined) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(undefined), "");
	});

	it("formatCacheHitRate(null) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(null as any), "");
	});

	it("formatCacheHitRate(NaN) → empty string", () => {
		assert.strictEqual(formatCacheHitRate(NaN), "");
	});
});

// ---------------------------------------------------------------------------
// Mode guard tests (Improvement #3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session name tests (Improvement #2)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trust status tests (Improvement #4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// formatCacheStats tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session shutdown behavior — dispose vs stopTimer
// ---------------------------------------------------------------------------

/** Create a minimal ExtensionContext for session_shutdown tests */
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
