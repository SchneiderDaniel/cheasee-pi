/**
 * Phase 4: /lsp-auditor command output includes diagnostics.
 *
 * Captures the registered command handler via a fake `pi.registerCommand`
 * and asserts the RPC/JSON structured payload always carries an object
 * diagnostics field derived from result.diagnostics.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/lsp-auditor/test/lsp-auditor-command-output.test.mts
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { LspRuntime, JsonRpcModule } from "../types.ts";
import { setLspRuntime, resetLspRuntime } from "../lsp-client.ts";
import lspAuditor from "../index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolvePath(__dirname, "../index.ts");

// ─── Mock runtime ────────────────────────────────────────────────────

let mockConnection: any = null;

function fakeChild() {
	return {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		pid: 1,
		on: mock.fn(),
		removeAllListeners: mock.fn(),
		kill: mock.fn(() => true),
	};
}

function setupRuntime(diagnosticsByUri: Record<string, unknown[]>): void {
	mockConnection = {
		sendRequest: mock.fn(async (method: string) => (method === "initialize" ? {} : null)),
		sendNotification: mock.fn(async () => {}),
		onNotification: mock.fn((handler: Function) => {
			setImmediate(() => {
				for (const [uri, diagnostics] of Object.entries(diagnosticsByUri)) {
					handler("textDocument/publishDiagnostics", { uri, diagnostics });
				}
			});
		}),
		onError: mock.fn(),
		listen: mock.fn(),
		dispose: mock.fn(),
	};

	const runtime: LspRuntime = {
		spawn: mock.fn(() => fakeChild()) as any,
		execFile: mock.fn((...args: any[]) => {
			const cb = [...args].reverse().find((a) => typeof a === "function");
			cb(null, "", "");
		}) as any,
		existsSync: mock.fn(() => true),
		readFile: mock.fn(async () => "const x = 1;\n") as any,
		loadJsonRpc: mock.fn(async (): Promise<JsonRpcModule | null> => ({
			StreamMessageReader: class {
				constructor(_s: unknown) {
					/* noop */
				}
			} as unknown as new (stream: unknown) => unknown,
			StreamMessageWriter: class {
				constructor(_s: unknown) {
					/* noop */
				}
			} as unknown as new (stream: unknown) => unknown,
			createMessageConnection: mock.fn(() => mockConnection),
		})) as any,
	};
	setLspRuntime(runtime);
}

function errorDiag(message = "mock error") {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		message,
	};
}

function makeGitFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-cmd-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/app.ts"), "const x: number = 1;\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	writeFileSync(join(dir, "src/app.ts"), "const x: number = 'bad';\n");
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, ".pi/settings.json"),
		JSON.stringify({
			lspAuditor: {
				servers: [
					{ extensions: [".ts"], command: "mock-lsp", args: [], severityThreshold: "warning" },
				],
			},
		}),
	);
	return dir;
}

function captureHandler(messages: any[]): (args: string, ctx: any) => Promise<void> {
	let handler: any;
	const pi = {
		registerCommand: mock.fn((_name: string, opts: any) => {
			handler = opts.handler;
		}),
		sendMessage: mock.fn((msg: any) => messages.push(msg)),
		sendUserMessage: mock.fn(),
		appendEntry: mock.fn(),
	} as any;
	lspAuditor(pi);
	assert.ok(typeof handler === "function", "command handler registered");
	return handler;
}

function makeCtx(dir: string, mode: string) {
	return {
		mode,
		hasUI: false,
		isProjectTrusted: () => true,
		ui: { notify: mock.fn() },
		sessionManager: {
			getCwd: () => dir,
			getBranch: () => [],
			getEntries: () => [],
		},
	} as any;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("/lsp-auditor command structured output", () => {
	let dirs: string[] = [];
	beforeEach(() => {
		dirs = [];
	});
	afterEach(() => {
		resetLspRuntime();
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("RPC mode with findings → payload contains diagnostics object with the finding", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ [uri]: [errorDiag()] });
		const messages: any[] = [];
		const handler = captureHandler(messages);

		await handler("", makeCtx(dir, "rpc"));

		const payload = JSON.parse(messages[0].content);
		assert.notStrictEqual(payload.diagnostics, null, "diagnostics must never be null");
		assert.ok(Array.isArray(payload.diagnostics.files), "diagnostics.files is an array");
		const messages_ = payload.diagnostics.files.flatMap((f: any) => f.issues.map((i: any) => i.message));
		assert.ok(messages_.includes("mock error"), "finding present in structured output");
		assert.ok("proceed" in payload && "note" in payload, "proceed/note keys present");
	});

	it("JSON mode → same structured shape as RPC", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ [uri]: [errorDiag()] });
		const messages: any[] = [];
		const handler = captureHandler(messages);

		await handler("", makeCtx(dir, "json"));

		const payload = JSON.parse(messages[0].content);
		assert.ok(Array.isArray(payload.diagnostics.files));
		assert.strictEqual(payload.diagnostics.files[0].issues[0].message, "mock error");
	});

	it("RPC mode clean audit → diagnostics is { files: [] }, never null/omitted", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ [uri]: [] });
		const messages: any[] = [];
		const handler = captureHandler(messages);

		await handler("", makeCtx(dir, "rpc"));

		const payload = JSON.parse(messages[0].content);
		assert.deepStrictEqual(payload.diagnostics, { files: [] });
	});

	it("[source guard] index.ts has no extractLastDiagnostics and serializes result.diagnostics", () => {
		const src = readFileSync(INDEX_TS, "utf-8");
		assert.ok(!src.includes("extractLastDiagnostics"), "dead extractor removed");
		assert.ok(src.includes("result.diagnostics"), "serializes result.diagnostics");
	});
});
