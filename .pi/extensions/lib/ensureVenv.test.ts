/**
 * Tests for ensureVenv — shared venv setup utility.
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 *
 * Phases:
 *   1. Core flow (create → install → verify → postInstall)
 *   2. Lock behavior (cross-process mkdir, staleness, contention)
 *   3. In-memory retry cache (TTL, retry limit, success caching)
 *   4. Error paths (EnsureVenvError per step)
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureVenv, EnsureVenvError } from "./ensureVenv.ts";
import type { ExecFn, EnsureVenvConfig } from "./ensureVenv.ts";

/**
 * Helper: get the lock dir path as created by proper-lockfile.
 * proper-lockfile appends ".lock" to the base path returned by lockFilePathFor.
 * Currently we construct this identically to the old lockDirFor (same path suffix).
 */
function lockDirPath(cwd: string, venvName: string): string {
	const safe = venvName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(cwd, ".pi", `ensureVenv.${safe}.lock`);
}

// ── Mock exec factory ──

interface MockHandlers {
	/** exec(pythonPath, ["-c", verifyCommand]) — quick/double-check verify */
	verify?: { code: number; stdout: string; stderr: string };
	/** exec("python3", ["-m", "venv", ...]) — venv creation */
	create?: { code: number; stdout: string; stderr: string };
	/** exec(pythonPath, ["-m", "pip", "install", ...]) — pip install */
	install?: { code: number; stdout: string; stderr: string };
	/** exec(pythonPath, ["-m", "scrapling.cli", ...]) — scrapling post-install */
	postInstall?: { code: number; stdout: string; stderr: string };
	/** catch-all for any unhandled command */
	default?: { code: number; stdout: string; stderr: string };
}

interface MockCallbacks {
	onVerify?: (args: string[]) => void;
	onCreate?: (args: string[]) => void;
	onInstall?: (args: string[]) => void;
	onPostInstall?: (args: string[]) => void;
	onRm?: (args: string[]) => void;
	onAny?: (cmd: string, args: string[]) => void;
}

const DEFAULT_HANDLERS: Required<MockHandlers> = {
	verify: { code: 1, stdout: "", stderr: "not found" },
	create: { code: 0, stdout: "", stderr: "" },
	install: { code: 0, stdout: "", stderr: "" },
	postInstall: { code: 0, stdout: "", stderr: "" },
	default: { code: 1, stdout: "", stderr: "mock: unhandled" },
};

function makeMockExec(handlers: MockHandlers = {}, callbacks: MockCallbacks = {}): ExecFn {
	const merged: Required<MockHandlers> = { ...DEFAULT_HANDLERS, ...handlers };
	/** Whether the test explicitly provided a verify handler. */
	const hasCustomVerify = "verify" in handlers;
	/** Stateful: after venv is set up (create/install), verify passes. */
	let setupDone = false;

	return async (cmd: string, args: string[]) => {
		callbacks.onAny?.(cmd, args);

		// exec(pythonPath, ["-c", ...]) — verify check
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			callbacks.onVerify?.(args);
			// After venv is set up, return success unless test provided custom verify
			if (setupDone && !hasCustomVerify) {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			return merged.verify;
		}

		// exec("rm", ["-rf", ...]) — cleanup
		if (cmd === "rm" && args[0] === "-rf") {
			callbacks.onRm?.(args);
			return { code: 0, stdout: "", stderr: "" };
		}

		// exec("python3", ["-m", "venv", ...]) — create venv
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			callbacks.onCreate?.(args);
			// Simulate venv directory structure so pythonPath exists
			const venvPath = args[args.length - 1];
			try {
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
			} catch {
				// Already exists or parallel test
			}
			const result = merged.create;
			if (result.code === 0) setupDone = true;
			return result;
		}

		// exec(pythonPath, ["-m", "pip", "install", ...]) — pip install
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "pip") {
			callbacks.onInstall?.(args);
			const result = merged.install;
			if (result.code === 0) setupDone = true;
			return result;
		}

		// exec(pythonPath, ["-m", "scrapling.cli", ...]) — post-install
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
			callbacks.onPostInstall?.(args);
			return merged.postInstall;
		}

		return merged.default;
	};
}

// ── Test setup ──

interface TestConfig {
	handlers?: MockHandlers;
	callbacks?: MockCallbacks;
	config?: Partial<EnsureVenvConfig>;
}

interface TestContext {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

function setupTest(opts: TestConfig = {}): TestContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ensureVenv-test-"));

	const execFn = makeMockExec(opts.handlers, opts.callbacks);
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>>;

	return { cwd, exec };
}

function makeConfig(ctx: TestContext, overrides: Partial<EnsureVenvConfig> = {}): EnsureVenvConfig {
	return {
		exec: ctx.exec,
		cwd: ctx.cwd,
		venvName: "test-venv",
		pipArgs: ["test-pkg"],
		verifyCommand: "import test; print('ok')",
		...overrides,
	};
}

// ══════════════════════════════════════════════════════════════════════
//  Phase 1: Core flow
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — core flow", () => {
	it("(entity) creates venv → installs packages → verifies → returns created:true", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx);

		const result = await ensureVenv(config);

		assert.equal(result.created, true);
		assert.ok(result.pythonPath.includes("test-venv/bin/python3"));
	});

	it("(entity) quick path: verify passes immediately → returns created:false, no pip install", async () => {
		const installCalls: Array<{ cmd: string; args: string[] }> = [];
		const ctx = setupTest({
			handlers: { verify: { code: 0, stdout: "ok", stderr: "" } },
			callbacks: { onInstall: (args) => installCalls.push({ cmd: "", args }) },
		});
		const config = makeConfig(ctx);

		const result = await ensureVenv(config);

		assert.equal(result.created, false);
		assert.equal(installCalls.length, 0, "should not call pip install");
	});

	it("(entity) config: custom pipArgs and verifyCommand reflected in exec calls", async () => {
		const execCalls: Array<{ cmd: string; args: string[] }> = [];
		const ctx = setupTest({
			callbacks: { onAny: (cmd, args) => execCalls.push({ cmd, args }) },
		});
		const config = makeConfig(ctx, {
			pipArgs: ["custom-pkg==1.0", "another-pkg"],
			verifyCommand: "import custom; print('ok')",
		});

		await ensureVenv(config);

		// Find pip install call
		const pipCall = execCalls.find(
			(c) => c.cmd.includes("bin/python3") && c.args.includes("-m") && c.args.includes("pip"),
		);
		assert.ok(pipCall, "should make pip install call");
		assert.ok(pipCall.args.includes("custom-pkg==1.0"), "should include custom pip arg");
		assert.ok(pipCall.args.includes("another-pkg"), "should include another pip arg");

		// Find verify call
		const verifyCall = execCalls.find((c) => c.args[0] === "-c");
		assert.ok(verifyCall, "should make verify call");
		assert.ok(
			verifyCall.args[1] === "import custom; print('ok')",
			"should use custom verify command",
		);
	});

	it("(entity) onUpdate callback invoked at create and install steps", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		assert.ok(
			updates.some((t) => t.includes("Creating Python")),
			"should have create update",
		);
		assert.ok(
			updates.some((t) => t.includes("Installing packages")),
			"should have install update",
		);
	});

	it("(entity) postInstall hook called after pip install", async () => {
		let postInstallCalled = false;
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				postInstallCalled = true;
			},
		});

		await ensureVenv(config);
		assert.ok(postInstallCalled, "postInstall hook should be called");
	});

	it("(entity) return shape: pythonPath and created computed correctly", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx);

		const result = await ensureVenv(config);
		assert.ok(typeof result.pythonPath === "string");
		assert.ok(result.pythonPath.length > 0);
		assert.equal(result.created, true);
	});

	it("(entity) empty pip args: only create + verify, no install call", async () => {
		const installCalls: Array<{ cmd: string; args: string[] }> = [];
		const ctx = setupTest({
			callbacks: { onInstall: (args) => installCalls.push({ cmd: "", args }) },
		});
		const config = makeConfig(ctx, { pipArgs: [] });

		const result = await ensureVenv(config);
		assert.equal(result.created, true);
		assert.equal(installCalls.length, 0, "should not call pip install with empty pipArgs");
	});

	it("(entity) EnsureVenvError has step discriminator and optional execResult", () => {
		const err = new EnsureVenvError("test error", "create", { code: 1, stderr: "fail" });
		assert.equal(err.name, "EnsureVenvError");
		assert.equal(err.step, "create");
		assert.deepEqual(err.execResult, { code: 1, stderr: "fail" });
		assert.equal(err.message, "test error");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 2: Lock behavior
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — lock behavior", () => {
	it("(entity) cross-process lock: lock dir created before mutating exec and removed after", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx);

		const lockPath = lockDirPath(ctx.cwd, config.venvName);
		assert.ok(!exists(lockPath), "lock should not exist before setup");

		await ensureVenv(config);

		assert.ok(!exists(lockPath), "lock should be removed after setup");
	});

	it("(entity) lock released in finally when pip install throws", async () => {
		const ctx = setupTest({
			handlers: { install: { code: 1, stdout: "", stderr: "pip failed" } },
		});
		const config = makeConfig(ctx);

		const lockPath = lockDirPath(ctx.cwd, config.venvName);

		await assert.rejects(() => ensureVenv(config));

		assert.ok(!exists(lockPath), "lock should be removed after error");
	});

	it("(entity) lock released in finally when postInstall throws", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				throw new Error("postInstall failed");
			},
		});

		const lockPath = lockDirPath(ctx.cwd, config.venvName);

		await assert.rejects(() => ensureVenv(config));

		assert.ok(!exists(lockPath), "lock should be removed after postInstall error");
	});

	it("(entity) orphaned lock (mtime > lockStaleMs): cleaned up then proceeds", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, { lockStaleMs: 2000 }); // minimum proper-lockfile allows

		const lockPath = lockDirPath(ctx.cwd, config.venvName);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.mkdirSync(lockPath, { recursive: false });
		// Set mtime to 60s in the past to make it stale
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, past, past);

		const result = await ensureVenv(config);
		assert.ok(result.created, "should succeed after cleaning stale lock");
		assert.ok(!exists(lockPath), "stale lock should be removed");
	});

	it("(entity) lock exhaustion: all retries fail → EnsureVenvError with step='lock'", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, { lockTimeoutMs: 50 });

		// Create a persistent lock dir that never gets removed
		const lockPath = lockDirPath(ctx.cwd, config.venvName);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.mkdirSync(lockPath, { recursive: false });

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return err instanceof EnsureVenvError && err.step === "lock";
			},
		);
	});

	it("(entity) config: lockTimeoutMs and lockStaleMs parameters affect behavior", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, { lockTimeoutMs: 1000, lockStaleMs: 2000 });

		const lockPath = lockDirPath(ctx.cwd, config.venvName);
		// Create a stale lock
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.mkdirSync(lockPath, { recursive: false });
		// Set mtime to 60s in the past so proper-lockfile treats it as stale
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, past, past);

		const result = await ensureVenv(config);
		assert.ok(result.created, "should succeed with configurable lock params");
	});

	it("(entity) existing stale lock dirs (pre-migration .lock dirs) cleaned up", async () => {
		// With proper-lockfile, stale lock dirs (even those created by old mkdir-based code)
		// are cleaned up via proper-lockfile's built-in stale detection
		const ctx = setupTest();
		const config = makeConfig(ctx, { lockStaleMs: 2000 });

		const lockPath = lockDirPath(ctx.cwd, config.venvName);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.mkdirSync(lockPath, { recursive: false });
		// Set mtime to 60s in the past
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, past, past);

		// should succeed because proper-lockfile detects stale lock and cleans it
		const result = await ensureVenv(config);
		assert.ok(result.created, "should clean up old-format stale lock dir");
		assert.ok(!exists(lockPath), "old lock dir should be removed");
	});

	it("(entity) proper-lockfile errors surface as EnsureVenvError with step='lock'", async () => {
		// When the .pi directory is not writable, proper-lockfile's mkdirSync will fail
		// with EACCES. This verifies the error surfaces as EnsureVenvError step='lock'.
		const ctx = setupTest();
		const config = makeConfig(ctx, { lockTimeoutMs: 50 });

		// Create .pi dir then make it read-only so proper-lockfile can't create the lock dir
		const piDir = path.join(ctx.cwd, ".pi");
		fs.mkdirSync(piDir, { recursive: true });
		fs.chmodSync(piDir, 0o444); // read-only

		try {
			await assert.rejects(
				() => ensureVenv(config),
				(err: unknown) => {
					return err instanceof EnsureVenvError && err.step === "lock";
				},
			);
		} finally {
			fs.chmodSync(piDir, 0o755); // restore
		}
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 2b: Structured logging on lock lifecycle
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — lock lifecycle logging", () => {
	it("(entity) onUpdate receives 'Acquiring venv lock' message at acquire start", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		const acquireMsg = updates.find((t) => t.startsWith("Acquiring venv lock"));
		assert.ok(acquireMsg, "should emit acquiring lock message");
		assert.ok(acquireMsg!.includes(`pid=${process.pid}`), "should include process pid");
	});

	it("(entity) onUpdate receives 'Lock acquired after' message with wait time", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		const acquiredMsg = updates.find((t) => t.startsWith("Lock acquired after"));
		assert.ok(acquiredMsg, "should emit lock acquired message");
		assert.ok(acquiredMsg!.includes("ms"), "should include wait time in ms");
		assert.ok(acquiredMsg!.includes(`pid=${process.pid}`), "should include process pid");
	});

	it("(entity) onUpdate receives 'Releasing venv lock' message at release", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		const releaseMsg = updates.find((t) => t.startsWith("Releasing venv lock"));
		assert.ok(releaseMsg, "should emit releasing lock message");
		assert.ok(releaseMsg!.includes(`pid=${process.pid}`), "should include process pid");
	});

	it("(entity) lock lifecycle messages appear in correct chronological order", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		const lockMsgs = updates.filter(
			(t) =>
				t.startsWith("Acquiring venv lock") ||
				t.startsWith("Lock acquired after") ||
				t.startsWith("Releasing venv lock"),
		);

		assert.ok(lockMsgs.length >= 3, "should have at least 3 lock lifecycle messages");
		// Check chronological order
		const acquireIdx = lockMsgs.findIndex((t) => t.startsWith("Acquiring"));
		const acquiredIdx = lockMsgs.findIndex((t) => t.startsWith("Lock acquired after"));
		const releaseIdx = lockMsgs.findIndex((t) => t.startsWith("Releasing"));

		assert.ok(acquireIdx >= 0, "acquire start should be present");
		assert.ok(acquiredIdx >= 0, "acquire success should be present");
		assert.ok(releaseIdx >= 0, "release should be present");
		assert.ok(acquireIdx < acquiredIdx, "acquire start should come before acquire success");
		assert.ok(acquiredIdx < releaseIdx, "acquire success should come before release");
	});

	it("(entity) all messages include process.pid in text content", async () => {
		const updates: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push(c.text);
				}
			},
		});

		await ensureVenv(config);

		const lockMsgs = updates.filter(
			(t) =>
				t.startsWith("Acquiring venv lock") ||
				t.startsWith("Lock acquired after") ||
				t.startsWith("Releasing venv lock"),
		);

		for (const msg of lockMsgs) {
			assert.ok(msg.includes(`pid=${process.pid}`), `message should include pid: "${msg}"`);
		}
	});

	it("(entity) onUpdate undefined: no crash, lock still works", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx); // onUpdate is undefined

		const result = await ensureVenv(config);
		assert.ok(result.created, "lock should work without onUpdate callback");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 3: In-memory retry cache
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — in-memory retry cache", () => {
	it("(entity) cached success: subsequent call with same key returns cached result, no exec", async () => {
		let execCount = 0;
		const ctx = setupTest({
			handlers: { verify: { code: 0, stdout: "ok", stderr: "" } },
			callbacks: {
				onAny: () => {
					execCount++;
				},
			},
		});
		const config = makeConfig(ctx);

		// First call: verify passes → cached
		const result1 = await ensureVenv(config);
		assert.equal(result1.created, false);

		// Second call: should use cache, no exec
		const result2 = await ensureVenv(config);
		assert.equal(result2.created, false);
		assert.equal(execCount, 1, "should not make additional exec calls on cache hit");
	});

	it("(entity) cached failure (retries exhausted): throws cached error", async () => {
		const ctx = setupTest({
			handlers: { create: { code: 1, stdout: "", stderr: "venv failed" } },
		});
		const config = makeConfig(ctx, { lockTimeoutMs: 100 });

		// First call: fails at create step
		await assert.rejects(() => ensureVenv(config));

		// Second call: should fail from cache without retrying
		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return err instanceof EnsureVenvError && err.message.includes("previously failed");
			},
		);
	});

	it("(entity) cache stored per (cwd,venvName): different venvs have independent cache entries", async () => {
		let execCount = 0;
		const ctx = setupTest({
			handlers: { verify: { code: 0, stdout: "ok", stderr: "" } },
			callbacks: {
				onAny: () => {
					execCount++;
				},
			},
		});

		// Use two different venv names
		const config1 = makeConfig(ctx, { venvName: "venv-a", pipArgs: ["pkg-a"] });
		const config2 = makeConfig(ctx, { venvName: "venv-b", pipArgs: ["pkg-b"] });

		await ensureVenv(config1);
		await ensureVenv(config2);

		// Both should execute (different cache keys)
		assert.ok(execCount >= 2, "both venvs should trigger exec calls");
	});

	it("(entity) cache stores success state: successful setup cached, subsequent call returns quickly", async () => {
		let pipCalls = 0;
		const ctx = setupTest({
			callbacks: {
				onInstall: () => {
					pipCalls++;
				},
				onAny: () => {}, // just to count
			},
		});
		const config = makeConfig(ctx);

		// Full setup
		const result1 = await ensureVenv(config);
		assert.equal(result1.created, true);
		assert.equal(pipCalls, 1);

		// Second call should hit cache (keyed on cwd+venvName) but wait — the cache key is
		// `${cwd}::${venvName}` — this should be a hit since the first call cached success
		const result2 = await ensureVenv(config);
		assert.equal(result2.created, false);
		assert.equal(pipCalls, 1, "should not re-install on cache hit");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 4: Error paths
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — error paths", () => {
	it("(entity) venv creation fails → EnsureVenvError step='create'", async () => {
		const ctx = setupTest({
			handlers: { create: { code: 1, stdout: "", stderr: "python3 not found" } },
		});
		const config = makeConfig(ctx);

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return (
					err instanceof EnsureVenvError &&
					err.step === "create" &&
					err.execResult?.code === 1 &&
					err.execResult?.stderr?.includes("python3 not found")
				);
			},
		);
	});

	it("(entity) pip install fails → EnsureVenvError step='install'", async () => {
		const ctx = setupTest({
			handlers: { install: { code: 1, stdout: "", stderr: "pip install failed" } },
		});
		const config = makeConfig(ctx);

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return (
					err instanceof EnsureVenvError &&
					err.step === "install" &&
					err.execResult?.stderr?.includes("pip install failed")
				);
			},
		);
	});

	it("(entity) verify command fails → EnsureVenvError step='verify'", async () => {
		// Make verify fail even after successful install
		const ctx = setupTest({
			handlers: {
				verify: { code: 1, stdout: "", stderr: "import error" },
			},
		});
		const config = makeConfig(ctx);

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return err instanceof EnsureVenvError && err.step === "verify";
			},
		);
	});

	it("(entity) postInstall hook rejects → error propagates", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				throw new EnsureVenvError("browser download failed", "install", {
					code: 1,
					stderr: "timeout",
				});
			},
		});

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return err instanceof EnsureVenvError && err.message.includes("browser download");
			},
		);
	});

	it("(entity) postInstall throws generic Error → wrapped as EnsureVenvError step='install'", async () => {
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				throw new Error("generic error");
			},
		});

		await assert.rejects(
			() => ensureVenv(config),
			(err: unknown) => {
				return (
					err instanceof EnsureVenvError &&
					err.step === "install" &&
					err.message.includes("Post-install step failed")
				);
			},
		);
	});

	it("(entity) ExecFn parameter type is structurally compatible with pi.exec signature", () => {
		// Just verify the type compiles — if it didn't, tsc would error.
		const fn: ExecFn = async (
			_cmd: string,
			_args: string[],
			_opts?: { timeout?: number; signal?: AbortSignal },
		) => ({
			code: 0,
			stdout: "",
			stderr: "",
		});
		assert.equal(typeof fn, "function");
	});
});

// ── Helpers ──

function exists(p: string): boolean {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
}
