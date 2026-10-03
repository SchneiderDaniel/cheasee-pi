/**
 * Phase 1–2: runPreAudit — active-branch retry scope + PreAuditResult payload.
 *
 * Integration: fake ctx/pi, injected mock LspRuntime, real temp git fixture.
 * Verifies the retry budget counts only active-branch entries and that every
 * PreAuditResult return declares diagnostics + retryCount.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/lsp-auditor/test/lsp-auditor-run-pre-audit.test.mts
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
import { runPreAudit, mapSessionEntriesToRetryEntries } from "../run-pre-audit.ts";
import { countRetryAttempts } from "../retry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_PRE_AUDIT_TS = resolvePath(__dirname, "../run-pre-audit.ts");
const TYPES_TS = resolvePath(__dirname, "../types.ts");

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

interface RuntimeOpts {
	diagnosticsByUri?: Record<string, unknown[]>;
	whichFails?: boolean;
}

function setupRuntime(opts: RuntimeOpts = {}): void {
	mockConnection = {
		sendRequest: mock.fn(async (method: string) => {
			if (method === "initialize") return { capabilities: {} };
			return null;
		}),
		sendNotification: mock.fn(async () => {}),
		onNotification: mock.fn((handler: Function) => {
			const byUri = opts.diagnosticsByUri ?? {};
			setImmediate(() => {
				for (const [uri, diagnostics] of Object.entries(byUri)) {
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
			if (opts.whichFails) {
				cb(new Error("not found"), "", "");
			} else {
				cb(null, "", "");
			}
		}) as any,
		existsSync: mock.fn(() => true),
		readFile: mock.fn(async () => "const x: number = 1;\n") as any,
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

// ─── Fixtures ────────────────────────────────────────────────────────

function errorDiag(message = "mock error") {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		message,
	};
}

function makeGitFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-preaudit-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/app.ts"), "const x: number = 1;\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	// Modify the tracked file so `git diff main --name-only` reports it
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

function retryEntry(issueNum: number) {
	return { type: "custom", customType: "lsp-audit-retry", data: { issueNum, attempt: 1 } };
}

function makeCtx(
	dir: string,
	branchEntries: Array<Record<string, unknown>>,
	allEntries: Array<Record<string, unknown>>,
	trusted = true,
) {
	return {
		isProjectTrusted: () => trusted,
		sessionManager: {
			getCwd: () => dir,
			getBranch: () => branchEntries,
			getEntries: () => allEntries,
		},
	} as any;
}

function makePi() {
	const sends: any[] = [];
	const appends: any[] = [];
	const pi = {
		sendUserMessage: mock.fn((msg: string, o: unknown) => sends.push({ msg, o })),
		appendEntry: mock.fn((type: string, data: unknown) => appends.push({ type, data })),
	} as any;
	return { pi, sends, appends };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("runPreAudit — retry budget scoped to active branch", () => {
	let dirs: string[] = [];
	beforeEach(() => {
		dirs = [];
	});
	afterEach(() => {
		resetLspRuntime();
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("counts only active-branch retry entries, not inactive-branch entries", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });

		const active = [retryEntry(42), retryEntry(42)];
		const all = [...active, retryEntry(42), retryEntry(42), retryEntry(42)];
		const { pi, appends } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, active, all),
		);

		assert.strictEqual(result.retryCount, 2, "only active-branch retries counted");
		assert.strictEqual(result.proceed, false, "retries remain → stay in Implementation");
		assert.strictEqual(appends.length, 1, "exactly one retry entry appended");
	});

	it("inactive-branch entries alone do not consume the active budget", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });

		const all = [retryEntry(42), retryEntry(42), retryEntry(42)];
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], all),
		);

		assert.strictEqual(result.retryCount, 0);
		assert.strictEqual(result.proceed, false);
	});

	it("three active retries → exhausted, proceed, no append, no follow-up", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });

		const active = [retryEntry(42), retryEntry(42), retryEntry(42)];
		const { pi, sends, appends } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, active, active),
		);

		assert.strictEqual(result.retryCount, 3);
		assert.strictEqual(result.proceed, true);
		assert.ok(result.note.includes("exhausted"), "note documents exhaustion");
		assert.strictEqual(appends.length, 0, "no retry entry appended when exhausted");
		assert.strictEqual(sends.length, 0, "no follow-up message when exhausted");
	});

	it("empty branch (null leaf / resetLeaf) → retryCount 0, no getEntries fallback", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });

		const all = [retryEntry(42), retryEntry(42), retryEntry(42)];
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], all),
		);

		assert.strictEqual(result.retryCount, 0);
		assert.strictEqual(result.proceed, false);
	});

	it("retries for a different issue are not counted", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });

		const active = [retryEntry(41), retryEntry(41)];
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, active, active),
		);

		assert.strictEqual(result.retryCount, 0);
	});

	it("[entity] countRetryAttempts counts only supplied active-branch entries", () => {
		const active = [retryEntry(42), retryEntry(42)];
		const mapped = mapSessionEntriesToRetryEntries(active);
		assert.strictEqual(countRetryAttempts(mapped, 42), 2);
	});

	it("[source guard] run-pre-audit.ts reads getBranch() and never getEntries()", () => {
		const src = readFileSync(RUN_PRE_AUDIT_TS, "utf-8");
		assert.ok(src.includes("getBranch("), "run-pre-audit.ts uses getBranch()");
		assert.ok(!src.includes("getEntries("), "run-pre-audit.ts must not call getEntries()");
	});
});

describe("runPreAudit — every return declares diagnostics + retryCount", () => {
	let dirs: string[] = [];
	beforeEach(() => {
		dirs = [];
	});
	afterEach(() => {
		resetLspRuntime();
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("diagnostics found → payload carries them", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [errorDiag()] } });
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], []),
		);

		assert.deepStrictEqual(result.diagnostics, [
			{
				file: resolvePath(dir, "src/app.ts"),
				line: 1,
				column: 1,
				severity: "Error",
				message: "mock error",
			},
		]);
		assert.strictEqual(typeof result.retryCount, "number");
		assert.strictEqual(result.proceed, false);
	});

	it("clean audit → diagnostics [], proceed true, retryCount 0", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		const uri = `file://${resolvePath(dir, "src/app.ts")}`;
		setupRuntime({ diagnosticsByUri: { [uri]: [] } });
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], []),
		);

		assert.deepStrictEqual(result.diagnostics, []);
		assert.strictEqual(result.proceed, true);
		assert.strictEqual(result.retryCount, 0);
	});

	it("all servers fail → diagnostics [], proceed true, note names failure", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		setupRuntime({ whichFails: true });
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], []),
		);

		assert.deepStrictEqual(result.diagnostics, []);
		assert.strictEqual(result.proceed, true);
		assert.ok(result.note.includes("all configured servers failed"));
	});

	it("project untrusted → diagnostics [], proceed true, retryCount number", async () => {
		const dir = makeGitFixture();
		dirs.push(dir);
		setupRuntime();
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], [], false),
		);

		assert.deepStrictEqual(result.diagnostics, []);
		assert.strictEqual(result.proceed, true);
		assert.strictEqual(typeof result.retryCount, "number");
	});

	it("git diff failure → diagnostics [], proceed true, retryCount number", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lsp-nongit-"));
		dirs.push(dir);
		setupRuntime();
		const { pi } = makePi();

		const result = await runPreAudit(
			{ issueNum: 42, worktreePath: dir, defaultBranch: "main", repo: "" },
			pi,
			makeCtx(dir, [], []),
		);

		assert.deepStrictEqual(result.diagnostics, []);
		assert.strictEqual(result.proceed, true);
		assert.strictEqual(typeof result.retryCount, "number");
	});

	it("[source guard] types.ts PreAuditResult declares diagnostics and retryCount", () => {
		const src = readFileSync(TYPES_TS, "utf-8");
		const match = src.match(/export interface PreAuditResult \{[\s\S]*?\n\}/);
		assert.ok(match, "PreAuditResult interface exists");
		assert.ok(match![0].includes("diagnostics:"), "declares diagnostics");
		assert.ok(match![0].includes("retryCount:"), "declares retryCount");
	});
});
