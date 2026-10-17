import assert from "node:assert";

import { describe, it, beforeEach, afterEach } from "node:test";

import { contextInfo } from "../index.ts";

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

describe("context-info extension — footer service links", () => {
	// The host session forwards CODEFLOW_PORT and PI_UI_PORT into the container
	// env; scrub both so the settings-derived assertions stay hermetic. Note
	// PI_UI_PORT is authoritative in ui.ts, so an inherited value would otherwise
	// shadow the settings ports asserted here.
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

	/** Temp workspace with explicit settings + optional sibling bare remote. */
	function makeWorkspace(settings: string): { root: string } {
		const parent = mkdtempSync(join(tmpdir(), "svc-links-"));
		const root = join(parent, "ws");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "cheasee-settings.json"), settings);
		const bare = join(parent, ".bare");
		mkdirSync(bare, { recursive: true });
		execSync(`git --git-dir "${bare}" init --bare`, { stdio: "ignore" });
		execSync(`git --git-dir "${bare}" config remote.origin.url "git@github.com:alice/foo.git"`, {
			stdio: "ignore",
		});
		return { root };
	}

	/** TUI harness capturing the last rendered rows + notify messages. */
	function makeHarness(cwd: string) {
		const handlers = new Map<string, (...args: any[]) => void>();
		const renders: string[][] = [];
		const notifies: string[] = [];
		const pi = {
			on: (event: string, handler: (...args: any[]) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			getSessionName: () => undefined,
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
						renders.push(component.render(120));
					}
				},
				setStatus: () => {},
				setWidget: () => {},
				setWorkingIndicator: () => {},
				notify: (msg: string) => {
					notifies.push(msg);
				},
				theme: { fg: (_c: string, t: string) => t },
			},
			isProjectTrusted: () => true,
			getContextUsage: () => undefined,
			sessionManager: { getSessionFile: () => "/tmp/test_uuid.jsonl" },
			model: { id: "test-model", contextWindow: 128000 },
			cwd,
		};
		return { pi, handlers, ctx, renders, notifies };
	}

	function lastRow(renders: string[][]): string {
		return renders.at(-1)!.at(-1)!;
	}

	it("resolves both links before install; CodeFlow notify matches the footer link", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600","codeflowPort":"9100"}}`);
		const { pi, handlers, ctx, renders, notifies } = makeHarness(root);
		contextInfo(pi as any);

		const uiUrl = "http://127.0.0.1:9600";
		const cfUrl = "http://localhost:9100/?repo=local/workspace&run=1";
		try {
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			resetCapabilitiesCache();
		}

		const row3 = lastRow(renders);
		assert.ok(row3.includes(`\x1b]8;;${uiUrl}\x1b\\UI`), `UI link must be present: ${row3}`);
		assert.ok(
			row3.includes(`\x1b]8;;${cfUrl}\x1b\\CodeFlow`),
			`CodeFlow link must be present: ${row3}`,
		);
		assert.strictEqual(
			notifies[1],
			`CodeFlow:  \x1b]8;;${cfUrl}\x1b\\${cfUrl}\x1b]8;;\x1b\\`,
			"notify must reuse the footer's CodeFlow URL (one resolution)",
		);

		await handlers.get("session_shutdown")!();
	});

	it("cross-layer: forwarded PI_UI_PORT beats stale settings docker.uiPort", async () => {
		// Mirrors resolveUIHostPort: the CLI forwards the sidecar's actually
		// published port (9713) even though the settings file still names 9600.
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600","codeflowPort":"9100"}}`);
		const { pi, handlers, ctx, renders } = makeHarness(root);
		contextInfo(pi as any);

		process.env.PI_UI_PORT = "9713";
		try {
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			delete process.env.PI_UI_PORT;
			resetCapabilitiesCache();
		}

		const row3 = lastRow(renders);
		assert.ok(
			row3.includes("\x1b]8;;http://127.0.0.1:9713\x1b\\UI"),
			`footer UI link must use the forwarded bound port: ${row3}`,
		);
		assert.ok(!row3.includes("127.0.0.1:9600"), `stale settings port must not appear: ${row3}`);

		await handlers.get("session_shutdown")!();
	});

	it("CLI resolution failure (marker set, PI_UI_PORT omitted) suppresses the UI link, CodeFlow survives", async () => {
		// Regression for the audit finding: on host port exhaustion the CLI omits
		// PI_UI_PORT and sets CHEASEE_UI_PORT_UNRESOLVED=1, so the footer must NOT
		// fall back to the settings/derived port (which names another workspace's
		// occupied bind).
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600","codeflowPort":"9100"}}`);
		const { pi, handlers, ctx, renders } = makeHarness(root);
		contextInfo(pi as any);

		process.env.CHEASEE_UI_PORT_UNRESOLVED = "1";
		try {
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
			resetCapabilitiesCache();
		}

		const row3 = lastRow(renders);
		assert.ok(!row3.includes("127.0.0.1"), `UI link must be suppressed entirely: ${row3}`);
		assert.ok(
			row3.includes("\x1b]8;;http://localhost:9100/?repo=local/workspace&run=1\x1b\\CodeFlow"),
			`CodeFlow link must survive a UI resolution failure: ${row3}`,
		);

		await handlers.get("session_shutdown")!();
	});

	it("hyperlinks:false → labels still OSC 8-wrapped in row 3", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600","codeflowPort":"9100"}}`);
		const { pi, handlers, ctx, renders } = makeHarness(root);
		contextInfo(pi as any);

		try {
			setCapabilities({ hyperlinks: false, images: null, trueColor: false });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			resetCapabilitiesCache();
		}

		const row3 = lastRow(renders);
		assert.ok(row3.includes("UI") && row3.includes("CodeFlow"), `labels must render: ${row3}`);
		assert.ok(
			row3.includes("\x1b]8;;http://127.0.0.1:9600\x1b\\UI"),
			`UI link must be OSC 8-wrapped regardless of the probe: ${row3}`,
		);

		await handlers.get("session_shutdown")!();
	});

	it("no workspace marker → only the For Info notify, no links in row 3", async () => {
		const outside = mkdtempSync(join(tmpdir(), "svc-none-"));
		const { pi, handlers, ctx, renders, notifies } = makeHarness(outside);
		contextInfo(pi as any);

		try {
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
		} finally {
			resetCapabilitiesCache();
		}

		assert.deepStrictEqual(notifies, ["For Info:  /cheasee-pi-info"], "no CodeFlow notify");
		const row3 = lastRow(renders);
		assert.ok(!row3.includes("UI") && !row3.includes("CodeFlow"), `no links: ${row3}`);

		await handlers.get("session_shutdown")!();
	});

	it("repeated session_start with a different workspace shows the new port", async () => {
		const first = makeWorkspace(`{"docker":{"uiPort":"9600","codeflowPort":"9100"}}`);
		const second = makeWorkspace(`{"docker":{"uiPort":"9601","codeflowPort":"9101"}}`);
		const { pi, handlers, ctx, renders } = makeHarness(first.root);
		contextInfo(pi as any);

		try {
			setCapabilities({ hyperlinks: true, images: null, trueColor: true });
			await handlers.get("session_start")!({}, ctx);
			assert.ok(lastRow(renders).includes("http://127.0.0.1:9600"), "first workspace port");

			ctx.cwd = second.root;
			await handlers.get("session_start")!({}, ctx);
			const row3 = lastRow(renders);
			assert.ok(row3.includes("http://127.0.0.1:9601"), `second workspace port: ${row3}`);
			assert.ok(!row3.includes("http://127.0.0.1:9600"), `stale port must be gone: ${row3}`);
		} finally {
			resetCapabilitiesCache();
		}

		await handlers.get("session_shutdown")!();
	});
});
