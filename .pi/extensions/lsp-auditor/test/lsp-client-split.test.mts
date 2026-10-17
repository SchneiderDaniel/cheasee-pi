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

const TS_MAPPING: ServerMapping = {
	extensions: [".ts"],
	command: "typescript-language-server",
	args: ["--stdio"],
	severityThreshold: "warning",
};

const SINGLE_FILE = ["src/test.ts"];

const EMPTY_FILES: string[] = [];

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

let pendingPublishes: Array<{ uri: string; diagnostics: unknown[]; delayMs: number }> = [];

let publisherInstalled = false;

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
		assert.ok(
			errors.some((e) => e.includes("Makefile")),
			"per-file error recorded",
		);
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
