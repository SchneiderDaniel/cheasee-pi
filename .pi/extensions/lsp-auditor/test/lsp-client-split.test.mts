/**
 * lsp-client-split — regression suite for the auditFileGroup split
 * (lsp-client.ts → lsp-client/{audit-group,audit-one,runtime}.ts).
 *
 * Imports the public contract via the shim (../lsp-client.ts) and the
 * internal modules directly (../lsp-client/runtime.ts, audit-one, audit-group)
 * to exercise the seam single-module guard, withTimeout race semantics
 * (issue #247), two-phase fan-out order, error paths, and teardown.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/lsp-auditor/test/lsp-client-split.test.mts
 */

import assert from "node:assert";
import { beforeEach, afterEach, describe, it, mock } from "node:test";
import { PassThrough } from "node:stream";
import type { ServerMapping, LspRuntime, JsonRpcModule } from "../types.ts";
import { auditFileGroup, setLspRuntime, resetLspRuntime } from "../lsp-client.ts";
import { getRuntime, createDefaultRuntime, withTimeout, sleep } from "../lsp-client/runtime.ts";
import {
	languageIdForExtension,
	lspSeverityToLabel,
	createDiagnosticsCollector,
	openFileForAudit,
} from "../lsp-client/audit-one.ts";
import { FILE_TIMEOUT_MS, DIAG_WAIT_TIMEOUT_MS } from "../lsp-client/audit-group.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

const TS_MAPPING: ServerMapping = {
	extensions: [".ts"],
	command: "typescript-language-server",
	args: ["--stdio"],
	severityThreshold: "warning",
};

const SINGLE_FILE = ["src/test.ts"];
const EMPTY_FILES: string[] = [];

// ─── Mock factories ──────────────────────────────────────────────────

let mockConnection: any = null;

function createPassThrough() {
	return new PassThrough();
}

function createFakeChildProcess() {
	return {
		stdin: createPassThrough(),
		stdout: createPassThrough(),
		stderr: createPassThrough(),
		exitCode: null,
		pid: 12345,
		on: mock.fn(),
		removeAllListeners: mock.fn(),
		kill: mock.fn(() => true),
	};
}

function createDefaultMockConnection() {
	return {
		sendRequest: mock.fn(async (method: string) => {
			if (method === "initialize") return { capabilities: {} };
			if (method === "shutdown") return null;
			return null;
		}),
		sendNotification: mock.fn(async () => {}),
		onNotification: mock.fn(),
		onError: mock.fn(),
		listen: mock.fn(),
		dispose: mock.fn(),
	};
}

function createMockRuntime(): LspRuntime {
	return {
		spawn: mock.fn(() => createFakeChildProcess()),
		execFile: mock.fn((...args: any[]) => {
			const cb = [...args].reverse().find((a: any) => typeof a === "function");
			if (cb) cb(null, "", "");
		}),
		existsSync: mock.fn(() => true),
		readFile: mock.fn(async () => "const x = 1;\n"),
		loadJsonRpc: mock.fn(async (): Promise<JsonRpcModule | null> => {
			return {
				StreamMessageReader: class {
					constructor(_stream: unknown) {}
				} as unknown as new (stream: unknown) => unknown,
				StreamMessageWriter: class {
					constructor(_stream: unknown) {}
				} as unknown as new (stream: unknown) => unknown,
				createMessageConnection: mock.fn(() => mockConnection),
			};
		}),
	};
}

/** Publish queue — drained when the collector's star handler is registered */
let pendingPublishes: Array<{ uri: string; diagnostics: unknown[]; delayMs: number }> = [];
let publisherInstalled = false;

/**
 * Queue a publishDiagnostics notification. The first call installs an
 * onNotification override that drains the shared queue once the orchestrator
 * registers its star handler (setImmediate, or setTimeout for delayed waves).
 */
function publishDiagnostics(uri: string, diagnostics: unknown[], delayMs = 0) {
	pendingPublishes.push({ uri, diagnostics, delayMs });
	if (!publisherInstalled) {
		publisherInstalled = true;
		mockConnection.onNotification = mock.fn((handler: Function) => {
			for (const p of pendingPublishes) {
				const fire = () =>
					handler("textDocument/publishDiagnostics", { uri: p.uri, diagnostics: p.diagnostics });
				if (p.delayMs > 0) setTimeout(fire, p.delayMs);
				else setImmediate(fire);
			}
		});
	}
}

/** Reset publish queue/install state per test (call from beforeEach) */
function resetPublishes() {
	pendingPublishes = [];
	publisherInstalled = false;
}

function singleDiagnostic(message: string, severity = 1, line = 0, character = 6) {
	return {
		range: { start: { line, character }, end: { line, character: character + 1 } },
		severity,
		message,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("runtime.ts — withTimeout contract (issue #247)", () => {
	it("resolves the value when the promise fulfills before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 100);
		assert.strictEqual(result, 42);
	});

	it("resolves null exactly when the timeout fires", async () => {
		const result = await withTimeout(new Promise(() => {}), 10);
		assert.strictEqual(result, null);
	});

	it("propagates a rejection arriving before the timeout", async () => {
		await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 100), /boom/);
	});

	it("absorbs a late rejection after timeout resolution — no unhandledRejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			let rejectLater!: (e: Error) => void;
			const slow = new Promise<never>((_resolve, reject) => {
				rejectLater = reject;
			});
			const result = await withTimeout(slow, 10);
			assert.strictEqual(result, null, "timeout wins");
			rejectLater(new Error("late boom"));
			await sleep(0);
			assert.strictEqual(unhandled.length, 0, "late rejection must be absorbed");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("sleep resolves after the requested ms", async () => {
		const start = Date.now();
		await sleep(20);
		assert.ok(Date.now() - start >= 15, "sleep should take ~20ms");
	});
});

describe("runtime.ts — seam single-module guard + default runtime", () => {
	beforeEach(() => {
		mockConnection = createDefaultMockConnection();
		resetPublishes();
	});

	afterEach(() => {
		resetLspRuntime();
	});

	it("auditFileGroup observes the runtime injected via runtime.ts setLspRuntime", async () => {
		const sentinel = createMockRuntime() as any;
		setLspRuntime(sentinel);
		assert.strictEqual(getRuntime(), sentinel, "getRuntime returns the injected runtime");
		publishDiagnostics("file:///worktree/src/test.ts", [singleDiagnostic("Diag")]);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.strictEqual(result.errors.length, 0);
		assert.ok(sentinel.spawn.mock.calls.length >= 1, "sentinel.spawn must be used");
		assert.ok(sentinel.execFile.mock.calls.length >= 1, "sentinel.execFile must be used");
		assert.ok(sentinel.readFile.mock.calls.length >= 1, "sentinel.readFile must be used");
		assert.ok(sentinel.loadJsonRpc.mock.calls.length >= 1, "sentinel.loadJsonRpc must be used");
	});

	it("resetLspRuntime is idempotent and falls back to the default runtime path", async () => {
		resetLspRuntime();
		resetLspRuntime();
		assert.ok(getRuntime(), "default runtime is constructed after reset");
	});

	it("createDefaultRuntime().loadJsonRpc() resolves the real vscode-jsonrpc module", async () => {
		const rt = createDefaultRuntime();
		const mod = await rt.loadJsonRpc();
		assert.ok(mod, "vscode-jsonrpc should resolve in the test environment");
		assert.strictEqual(typeof mod!.createMessageConnection, "function");
	});
});

describe("audit-one.ts — pure helpers", () => {
	it("languageIdForExtension maps known extensions and falls back to the bare extension", () => {
		assert.strictEqual(languageIdForExtension(".ts"), "typescript");
		assert.strictEqual(languageIdForExtension(".tsx"), "typescriptreact");
		assert.strictEqual(languageIdForExtension(".js"), "javascript");
		assert.strictEqual(languageIdForExtension(".jsx"), "javascriptreact");
		assert.strictEqual(languageIdForExtension(".py"), "python");
		assert.strictEqual(languageIdForExtension(".rs"), "rust");
		assert.strictEqual(languageIdForExtension(".go"), "go");
		assert.strictEqual(languageIdForExtension(".txt"), "txt");
	});

	it("languageIdForExtension('') → '' (explicit fail-closed contract)", () => {
		assert.strictEqual(languageIdForExtension(""), "");
	});

	it("lspSeverityToLabel maps severity numbers", () => {
		assert.strictEqual(lspSeverityToLabel(1), "Error");
		assert.strictEqual(lspSeverityToLabel(2), "Warning");
		assert.strictEqual(lspSeverityToLabel(3), "Information");
		assert.strictEqual(lspSeverityToLabel(4), "Hint");
		assert.strictEqual(lspSeverityToLabel(0), "Information");
		assert.strictEqual(lspSeverityToLabel(5), "Information");
	});
});

describe("audit-one.ts — openFileForAudit fail-closed (extension-less file)", () => {
	it("extension-less file → no didOpen, no openedUris entry, error recorded", async () => {
		const rt = createMockRuntime();
		const connection = createDefaultMockConnection() as any;
		const openedUris = new Set<string>();
		const errors: string[] = [];

		await openFileForAudit(rt, connection, "Makefile", "/worktree", openedUris, errors);

		const didOpenCalls = connection.sendNotification.mock.calls.filter(
			(c: any) => c.arguments[0] === "textDocument/didOpen",
		);
		assert.strictEqual(didOpenCalls.length, 0, "no didOpen sent for extension-less file");
		assert.strictEqual(openedUris.size, 0);
		assert.ok(errors.some((e) => e.includes("Makefile")), "per-file error recorded");
	});

	it("control: src/a.ts still sends didOpen with languageId 'typescript'", async () => {
		const rt = createMockRuntime();
		const connection = createDefaultMockConnection() as any;
		const openedUris = new Set<string>();
		const errors: string[] = [];

		await openFileForAudit(rt, connection, "src/a.ts", "/worktree", openedUris, errors);

		const didOpenCall = connection.sendNotification.mock.calls.find(
			(c: any) => c.arguments[0] === "textDocument/didOpen",
		);
		assert.ok(didOpenCall, "didOpen should have been sent");
		assert.strictEqual(didOpenCall.arguments[1].textDocument.languageId, "typescript");
		assert.strictEqual(openedUris.size, 1);
		assert.strictEqual(errors.length, 0);
	});
});

describe("audit-one.ts — diagnostics collector", () => {
	function captureCollector() {
		let handler: ((method: string, params: unknown) => void) | null = null;
		const fakeConn = {
			onNotification: mock.fn((h: any) => {
				handler = h;
			}),
		} as any;
		const collector = createDiagnosticsCollector(fakeConn);
		return {
			collector,
			publish: (method: string, params: unknown) => handler!(method, params),
		};
	}

	it("repeat publish for the same URI → last write wins, no duplicates", () => {
		const { collector, publish } = captureCollector();
		publish("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			diagnostics: [singleDiagnostic("first")],
		});
		publish("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			diagnostics: [singleDiagnostic("second")],
		});
		const diags = collector.diagnosticsMap.get("/a.ts")!;
		assert.strictEqual(diags.length, 1);
		assert.strictEqual(diags[0].message, "second");
		assert.strictEqual(collector.diagnosedUris.size, 1);
	});

	it("non-publishDiagnostics notifications are ignored", () => {
		const { collector, publish } = captureCollector();
		publish("window/logMessage", { type: 3, message: "hello" });
		publish("textDocument/didOpen", { textDocument: { uri: "file:///a.ts" } });
		assert.strictEqual(collector.diagnosticsMap.size, 0);
		assert.strictEqual(collector.diagnosedUris.size, 0);
	});

	it("URL-encoded URI decoded to path; malformed URI falls back to raw path without throwing", () => {
		const { collector, publish } = captureCollector();
		publish("textDocument/publishDiagnostics", {
			uri: "file:///worktree/my%20file.ts",
			diagnostics: [singleDiagnostic("enc")],
		});
		assert.ok(collector.diagnosticsMap.has("/worktree/my file.ts"), "should decode %20");
		publish("textDocument/publishDiagnostics", {
			uri: "file:///worktree/%E0%A4%A",
			diagnostics: [singleDiagnostic("bad")],
		});
		assert.ok(
			collector.diagnosticsMap.has("file:///worktree/%E0%A4%A".replace(/^file:\/\//, "")),
			"malformed URI should fall back to raw path",
		);
	});

	it("0-based → 1-based line/column shift, severity label, empty message preserved", () => {
		const { collector, publish } = captureCollector();
		publish("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			diagnostics: [
				{ ...singleDiagnostic(""), severity: 2 },
				{
					range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
					severity: 4,
					message: "hint",
				},
			],
		});
		const diags = collector.diagnosticsMap.get("/a.ts")!;
		assert.strictEqual(diags[0].line, 1);
		assert.strictEqual(diags[0].column, 7);
		assert.strictEqual(diags[0].severity, "Warning");
		assert.strictEqual(diags[0].message, "", "empty message preserved");
		assert.strictEqual(diags[1].line, 4);
		assert.strictEqual(diags[1].severity, "Hint");
	});
});

describe("audit-group.ts — orchestrator error paths", () => {
	beforeEach(() => {
		mockConnection = createDefaultMockConnection();
		resetPublishes();
		setLspRuntime(createMockRuntime());
	});

	afterEach(() => {
		resetLspRuntime();
	});

	it("preflight which-failure → exact error, early return, spawn never called", async () => {
		const rt = createMockRuntime();
		rt.execFile = mock.fn((...args: any[]) => {
			const cb = [...args].reverse().find((a: any) => typeof a === "function");
			cb(new Error("ENOENT"), "", "");
		});
		setLspRuntime(rt);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.deepStrictEqual(result.errors, [
			"LSP server typescript-language-server not found on PATH",
		]);
		assert.strictEqual(result.diagnostics.length, 0);
		assert.strictEqual(
			(rt.spawn as any).mock.calls.length,
			0,
			"preflight runs once per group, not per file",
		);
	});

	it("spawn exitCode non-zero → 'failed to start (exit N)'", async () => {
		const rt = createMockRuntime();
		const child: any = createFakeChildProcess();
		child.exitCode = 42;
		rt.spawn = mock.fn(() => child) as any;
		setLspRuntime(rt);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.deepStrictEqual(result.errors, [
			"LSP server typescript-language-server failed to start (exit 42)",
		]);
	});

	it("destroyed stdio streams → 'failed to start (streams destroyed)'", async () => {
		const rt = createMockRuntime();
		const child: any = createFakeChildProcess();
		(child.stdin as any).destroy();
		(child.stdout as any).destroy();
		rt.spawn = mock.fn(() => child) as any;
		setLspRuntime(rt);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.deepStrictEqual(result.errors, [
			"LSP server typescript-language-server failed to start (streams destroyed)",
		]);
	});

	it("loadJsonRpc null → 'vscode-jsonrpc not installed', empty diagnostics", async () => {
		const rt = createMockRuntime();
		rt.loadJsonRpc = mock.fn(async () => null);
		setLspRuntime(rt);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.deepStrictEqual(result.errors, [
			"vscode-jsonrpc not installed — cannot audit typescript-language-server",
		]);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	it("initialize timeout (mock timers) → 'timed out during initialize', early return", async () => {
		mockConnection.sendRequest = mock.fn(() => new Promise(() => {}));
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const promise = auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
			await new Promise((r) => setImmediate(r)); // let the flow reach the initialize await
			mock.timers.tick(30_000);
			const result = await promise;
			assert.deepStrictEqual(result.errors, [
				"LSP server typescript-language-server timed out during initialize",
			]);
			assert.strictEqual(result.diagnostics.length, 0);
		} finally {
			mock.timers.reset();
		}
	});

	it("shutdown timeout (mock timers) → null tolerated, teardown proceeds, no error", async () => {
		mockConnection.sendRequest = mock.fn(async (method: string) => {
			if (method === "initialize") return { capabilities: {} };
			return new Promise(() => {}); // shutdown never resolves
		});
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const promise = auditFileGroup(TS_MAPPING, EMPTY_FILES, "/worktree");
			await new Promise((r) => setImmediate(r));
			mock.timers.tick(30_000); // fires the 10s shutdown timer
			const result = await promise;
			assert.strictEqual(result.errors.length, 0, "shutdown timeout is tolerated");
			assert.ok(mockConnection.dispose.mock.calls.length >= 1, "dispose called");
		} finally {
			mock.timers.reset();
		}
	});

	it("missing worktree file → per-file error, remaining files still opened and diagnosed", async () => {
		const rt = createMockRuntime();
		rt.existsSync = mock.fn((p: string) => !p.endsWith("src/b.ts"));
		setLspRuntime(rt);
		publishDiagnostics("file:///worktree/src/a.ts", [singleDiagnostic("Diag A")]);
		publishDiagnostics("file:///worktree/src/c.ts", [singleDiagnostic("Diag C")]);

		const result = await auditFileGroup(
			TS_MAPPING,
			["src/a.ts", "src/b.ts", "src/c.ts"],
			"/worktree",
		);
		assert.ok(result.errors.includes("File not found in worktree: src/b.ts"));
		assert.strictEqual(result.diagnostics.length, 2, "a and c still diagnosed");
	});

	it("uppercase extension → language id matched case-insensitively", async () => {
		publishDiagnostics("file:///worktree/src/TEST.TS", [singleDiagnostic("Diag")]);
		await auditFileGroup(TS_MAPPING, ["src/TEST.TS"], "/worktree");
		const didOpenCall = mockConnection.sendNotification.mock.calls.find(
			(c: any) => c.arguments[0] === "textDocument/didOpen",
		);
		assert.ok(didOpenCall, "didOpen should have been sent");
		assert.strictEqual(didOpenCall.arguments[1].textDocument.languageId, "typescript");
	});

	it("two-phase fan-out: one collector registration, all didOpen before shutdown, all files diagnosed", async () => {
		const callOrder: string[] = [];
		mockConnection.sendNotification = mock.fn(async (method: string) => {
			callOrder.push(`notification:${method}`);
			return undefined;
		});
		mockConnection.sendRequest = mock.fn(async (method: string) => {
			callOrder.push(`request:${method}`);
			if (method === "initialize") return { capabilities: {} };
			if (method === "shutdown") return null;
			return null;
		});
		const files = ["src/a.ts", "src/b.ts"];
		publishDiagnostics("file:///worktree/src/a.ts", [singleDiagnostic("Diag A")]);
		publishDiagnostics("file:///worktree/src/b.ts", [singleDiagnostic("Diag B")]);

		const result = await auditFileGroup(TS_MAPPING, files, "/worktree");

		assert.strictEqual(
			mockConnection.onNotification.mock.calls.length,
			1,
			"collector must be registered once for the group (two-phase), not once per file",
		);
		const didOpens = callOrder.filter((c) => c === "notification:textDocument/didOpen");
		assert.strictEqual(didOpens.length, 2);
		const lastDidOpen = callOrder.lastIndexOf("notification:textDocument/didOpen");
		const shutdownIdx = callOrder.indexOf("request:shutdown");
		assert.ok(shutdownIdx > lastDidOpen, "all didOpen complete before shutdown");
		assert.strictEqual(result.diagnostics.length, 2, "both opened files diagnosed");
		assert.strictEqual(result.errors.length, 0);
	});

	it("slow server: diagnostics arriving across polls → all opened URIs collected", async () => {
		const files = ["src/a.ts", "src/b.ts"];
		publishDiagnostics("file:///worktree/src/a.ts", [singleDiagnostic("Diag A")], 100);
		publishDiagnostics("file:///worktree/src/b.ts", [singleDiagnostic("Diag B")], 500);

		const result = await auditFileGroup(TS_MAPPING, files, "/worktree");
		assert.strictEqual(result.diagnostics.length, 2, "both files' diagnostics collected");
	});

	it("severityThreshold applied post-collection (warning keeps Error+Warning, drops Hint)", async () => {
		publishDiagnostics("file:///worktree/src/test.ts", [
			singleDiagnostic("err", 1),
			singleDiagnostic("warn", 2),
			singleDiagnostic("hint", 4),
		]);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		const severities = result.diagnostics.map((d) => d.severity);
		assert.deepStrictEqual(severities.sort(), ["Error", "Warning"]);
	});

	it("shutdown ordering: shutdown request awaited before exit; exit rejection absorbed; dispose called", async () => {
		const callOrder: string[] = [];
		mockConnection.sendRequest = mock.fn(async (method: string) => {
			callOrder.push(`request:${method}`);
			if (method === "initialize") return { capabilities: {} };
			if (method === "shutdown") return null;
			return null;
		});
		mockConnection.sendNotification = mock.fn(async (method: string) => {
			callOrder.push(`notification:${method}`);
			if (method === "exit") throw new Error("connection already disposed");
			return undefined;
		});
		publishDiagnostics("file:///worktree/src/test.ts", [singleDiagnostic("Diag")]);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		const shutdownIdx = callOrder.indexOf("request:shutdown");
		const exitIdx = callOrder.indexOf("notification:exit");
		assert.ok(shutdownIdx >= 0 && exitIdx > shutdownIdx, "shutdown awaited before exit");
		assert.ok(
			!result.errors.some((e) => e.includes("exit")),
			"exit rejection must not leak into errors",
		);
		assert.ok(mockConnection.dispose.mock.calls.length >= 1, "dispose called");
	});

	it("crash mid-run (shutdown rejects) → single 'LSP server error' entry, collected diagnostics preserved", async () => {
		mockConnection.sendRequest = mock.fn(async (method: string) => {
			if (method === "initialize") return { capabilities: {} };
			if (method === "shutdown") throw new Error("protocol error mid-run");
			return null;
		});
		publishDiagnostics("file:///worktree/src/test.ts", [singleDiagnostic("Diag")]);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");

		assert.ok(
			result.errors.some(
				(e) => e === "LSP server typescript-language-server error: protocol error mid-run",
			),
			"single crash error expected",
		);
		assert.ok(result.diagnostics.length >= 1, "previously collected diagnostics preserved");
	});
});

describe("audit-group.ts — teardown (terminateChild)", () => {
	beforeEach(() => {
		mockConnection = createDefaultMockConnection();
		resetPublishes();
	});

	afterEach(() => {
		resetLspRuntime();
	});

	it("running child → SIGTERM, error listeners removed, SIGKILL after 5s", async () => {
		const rt = createMockRuntime();
		setLspRuntime(rt);

		// EMPTY_FILES → poll breaks immediately (no sleeps), so the run resolves
		// with only the initialize/shutdown withTimeout timers and the 5s kill
		// timer pending — no tick needed until the SIGKILL escalation.
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const result = await auditFileGroup(TS_MAPPING, EMPTY_FILES, "/worktree");
			assert.strictEqual(result.errors.length, 0);

			const child = (rt.spawn as any).mock.calls[0].result;
			assert.ok(
				child.kill.mock.calls.some((c: any) => c.arguments[0] === "SIGTERM"),
				"running child killed with SIGTERM",
			);
			assert.ok(child.removeAllListeners.mock.calls.length >= 1, "error listeners removed");

			mock.timers.tick(5_000);
			assert.ok(
				child.kill.mock.calls.some((c: any) => c.arguments[0] === "SIGKILL"),
				"5s escalation to SIGKILL",
			);
		} finally {
			mock.timers.reset();
		}
	});

	it("already-exited child → no kill call", async () => {
		const rt = createMockRuntime();
		const child: any = createFakeChildProcess();
		child.exitCode = 0;
		rt.spawn = mock.fn(() => child) as any;
		setLspRuntime(rt);
		publishDiagnostics("file:///worktree/src/test.ts", [singleDiagnostic("Diag")]);

		const result = await auditFileGroup(TS_MAPPING, SINGLE_FILE, "/worktree");
		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(child.kill.mock.calls.length, 0, "exited child must not be killed");
	});
});

describe("lsp-client.ts shim + single-source constants", () => {
	it("shim re-exports exactly the public API with unchanged names", async () => {
		const mod = await import("../lsp-client.ts");
		assert.deepStrictEqual(Object.keys(mod).sort(), [
			"auditFileGroup",
			"resetLspRuntime",
			"setLspRuntime",
		]);
		assert.strictEqual(typeof mod.auditFileGroup, "function");
		assert.strictEqual(typeof mod.setLspRuntime, "function");
		assert.strictEqual(typeof mod.resetLspRuntime, "function");
	});

	it("timeout constants are defined once in audit-group.ts (single source)", () => {
		assert.strictEqual(FILE_TIMEOUT_MS, 30_000);
		assert.strictEqual(DIAG_WAIT_TIMEOUT_MS, 30_000);
	});

	it("smoke: importing shim + all split modules resolves without TDZ/circular errors", async () => {
		await import("../lsp-client/audit-group.ts");
		await import("../lsp-client/audit-one.ts");
		await import("../lsp-client/runtime.ts");
		const rt = getRuntime();
		assert.ok(rt, "modules load cleanly in DAG order");
	});
});
