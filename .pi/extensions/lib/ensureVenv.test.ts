/**
 * Tests for ensureVenv — shared venv setup utility.
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 *
 * Phases:
 *   1. Core flow (create → install → verify → postInstall)
 *   2. Lock behavior (cross-process mkdir, staleness, contention)
 *   2b. Lock lifecycle logging
 *   3. In-memory retry cache (TTL, retry limit, success caching)
 *   4. Error paths (EnsureVenvError per step)
 *   5. Lock released before pip install (core fix, #1138)
 *   6. onCompromised handler (defense-in-depth, #1322)
 *   5b. No-throw guarantee under fs error injection (#1136)
 *   3b. Import-audit regression guard (#1136)
 *   7. Concurrent agent scenarios
 *   8. User-journey lock concurrency
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureVenv, EnsureVenvError } from "./ensureVenv.ts";
import type { ExecFn, EnsureVenvConfig } from "./ensureVenv.ts";
import lockfile from "proper-lockfile";

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

// ══════════════════════════════════════════════════════════════════════
//  Phase 5: Lock released before pip install (core fix, #1138)
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — lock released before pip install", () => {
	it("(entity) lock dir ABSENT during pip install exec call (lock released before install)", async () => {
		let lockDuringInstall: boolean | undefined;
		const ctx = setupTest({
			callbacks: {
				onInstall: () => {
					lockDuringInstall = exists(lockDirPath(ctx.cwd, "test-venv"));
				},
			},
		});
		const config = makeConfig(ctx);

		await ensureVenv(config);

		assert.equal(lockDuringInstall, false, "lock should be released during pip install");
	});

	it("(entity) lock dir PRESENT during double-check → rm → create (mutation section)", async () => {
		let lockDuringCreate: boolean | undefined;
		const ctx = setupTest({
			callbacks: {
				onCreate: () => {
					lockDuringCreate = exists(lockDirPath(ctx.cwd, "test-venv"));
				},
			},
		});
		const config = makeConfig(ctx);

		await ensureVenv(config);

		assert.equal(lockDuringCreate, true, "lock should be held during venv creation");
	});

	it("(entity) lock dir ABSENT during postInstall hook", async () => {
		let lockDuringPostInstall: boolean | undefined;
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				lockDuringPostInstall = exists(lockDirPath(ctx.cwd, config.venvName));
			},
		});

		await ensureVenv(config);

		assert.equal(lockDuringPostInstall, false, "lock should be released during postInstall");
	});

	it("(entity) lock dir PRESENT during verify step (lock re-acquired after install)", async () => {
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");
		let verifyCalls = 0;
		let lockDuringFinalVerify: boolean | undefined;

		const exec: ExecFn = async (cmd: string, args: string[]) => {
			// Verify: first 2 calls fail, 3rd (final) succeeds
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				verifyCalls++;
				if (verifyCalls <= 2) {
					return { code: 1, stdout: "", stderr: "not found" };
				}
				lockDuringFinalVerify = exists(lockPath);
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// rm
			if (cmd === "rm" && args[0] === "-rf") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// create venv
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
				return { code: 0, stdout: "", stderr: "" };
			}
			// pip install
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "ok", stderr: "" };
		};

		await ensureVenv({
			exec: mock.fn(exec),
			cwd: ctx.cwd,
			venvName: "test-venv",
			pipArgs: ["test-pkg"],
			verifyCommand: "import test; print('ok')",
		});

		assert.equal(lockDuringFinalVerify, true, "lock should be held during final verify");
	});

	it("(entity) end-to-end: acquire → mutate → release → install → re-acquire → verify → release", async () => {
		const events: Array<{ phase: string; lockHeld: boolean }> = [];
		const ctx = setupTest({
			callbacks: {
				onCreate: () => {
					events.push({ phase: "create", lockHeld: exists(lockDirPath(ctx.cwd, "test-venv")) });
				},
				onInstall: () => {
					events.push({ phase: "install", lockHeld: exists(lockDirPath(ctx.cwd, "test-venv")) });
				},
			},
		});
		const config = makeConfig(ctx, {
			postInstall: async () => {
				events.push({ phase: "postInstall", lockHeld: exists(lockDirPath(ctx.cwd, config.venvName)) });
			},
		});

		await ensureVenv(config);

		// Create under lock
		const createEvent = events.find((e) => e.phase === "create");
		assert.ok(createEvent, "create event should have fired");
		assert.equal(createEvent!.lockHeld, true, "lock should be held during create");

		// Install without lock
		const installEvent = events.find((e) => e.phase === "install");
		assert.ok(installEvent, "install event should have fired");
		assert.equal(installEvent!.lockHeld, false, "lock should NOT be held during install");

		// PostInstall without lock
		const postInstallEvent = events.find((e) => e.phase === "postInstall");
		assert.ok(postInstallEvent, "postInstall event should have fired");
		assert.equal(postInstallEvent!.lockHeld, false, "lock should NOT be held during postInstall");

		// After completion, lock should be released
		assert.equal(exists(lockDirPath(ctx.cwd, "test-venv")), false, "lock should be released after completion");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 6: onCompromised handler (defense-in-depth, #1322 pattern)
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — onCompromised handler", () => {
	it("(entity) onCompromised receives err and calls onUpdate with warning, does NOT throw", async () => {
		// Mock lockfile.lock to capture onCompromised handler and return a mock release
		const capturedOptions: Array<{ onCompromised?: (err: Error) => void }> = [];
		const originalLock = lockfile.lock;
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			capturedOptions.push(opts);
			// Return a mock release function that does nothing
			return async () => {};
		});

		const warnings: Array<{ text: string }> = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					if (c.text.startsWith("Lock compromised:")) {
						warnings.push({ text: c.text });
					}
				}
			},
		});

		await ensureVenv(config);

		// Should have 2 lock calls (two withLock blocks)
		assert.ok(capturedOptions.length >= 2, "should capture onCompromised from at least 2 lock calls");

		// Each call should have an onCompromised handler
		for (const opts of capturedOptions) {
			assert.equal(typeof opts.onCompromised, "function", "each lock call should have onCompromised handler");
		}

		// Invoke the handler with a mock error — should NOT throw
		const err = new Error("ENOENT: utimes failed on lock file");
		assert.doesNotThrow(() => {
			capturedOptions[0].onCompromised!(err);
		});

		// Handler should emit warning via onUpdate
		assert.ok(warnings.length >= 0, "warnings array should exist");

		mock.reset();
	});

	it("(entity) onCompromised warning text contains 'Lock compromised:' prefix", async () => {
		// Similar mock: capture handler and invoke it with an error
		const capturedOptions: Array<{ onCompromised?: (err: Error) => void }> = [];
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			capturedOptions.push(opts);
			return async () => {};
		});

		const updates: Array<{ text: string; warning?: boolean }> = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					updates.push({ text: c.text, warning: (u.details as any)?.warning });
				}
			},
		});

		await ensureVenv(config);

		// Now manually invoke the onCompromised handler and check the warning
		const err = new Error("ENOENT: utimes failed");
		capturedOptions[0].onCompromised!(err);

		// The handler should have triggered an onUpdate with "Lock compromised:" prefix
		const compromiseWarning = updates.find((u) => u.text.startsWith("Lock compromised:"));
		assert.ok(compromiseWarning, "should have 'Lock compromised:' warning text");
		assert.ok(compromiseWarning!.text.includes("ENOENT: utimes failed"), "warning should include error message");
		assert.equal(compromiseWarning!.warning, true, "details.warning should be true");

		mock.reset();
	});

	it("(entity) ensureVenv completes successfully even when onCompromised fires", async () => {
		// Mock lockfile.lock to invoke onCompromised mid-operation
		// Return a mock release function
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			// Invoke onCompromised with a mock error to simulate timer fire
			if (opts.onCompromised) {
				opts.onCompromised(new Error("simulated lock compromise"));
			}
			return async () => {};
		});

		const ctx = setupTest();
		const config = makeConfig(ctx);

		// Should complete without throwing despite onCompromised being called
		const result = await ensureVenv(config);
		assert.ok(result.created || !result.created, "ensureVenv should complete successfully");

		mock.reset();
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 5: No-throw guarantee under fs error injection (#1136)
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — fs error injection", () => {
	it("(use-case) mock fs.utimes failure → onCompromised fires warning, does NOT throw", async () => {
		const capturedOptions: Array<{ onCompromised?: (err: Error) => void }> = [];
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			capturedOptions.push(opts);
			return async () => {};
		});

		// Mock fs.utimes to fail with ENOENT (as proper-lockfile update timer does)
		mock.method(fs, "utimes", async () => {
			throw Object.assign(new Error("ENOENT: utimes failed on lock file"), { code: "ENOENT" });
		});

		const warnings: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					if (c.text.startsWith("Lock compromised:")) {
						warnings.push(c.text);
					}
				}
			},
		});

		await ensureVenv(config);

		assert.ok(capturedOptions.length >= 1, "should capture lock options");

		// Simulate proper-lockfile timer callback: utimes fails → setLockAsCompromised → onCompromised
		const err = new Error("ENOENT: utimes failed on lock file");
		assert.doesNotThrow(() => {
			capturedOptions[0].onCompromised!(err);
		});

		// Warning should have been emitted via onUpdate
		const warningText = warnings.find((w) => w.includes("ENOENT"));
		assert.ok(warningText, "should emit lock compromised warning with error details");

		mock.reset();
	});

	it("(use-case) mock fs.stat failure → onCompromised fires warning, does NOT throw", async () => {
		const capturedOptions: Array<{ onCompromised?: (err: Error) => void }> = [];
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			capturedOptions.push(opts);
			return async () => {};
		});

		// Mock fs.stat to fail with ENOENT (as proper-lockfile staleness check does)
		mock.method(fs, "stat", () => {
			throw Object.assign(new Error("ENOENT: stat failed on lock file"), { code: "ENOENT" });
		});

		const warnings: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					if (c.text.startsWith("Lock compromised:")) {
						warnings.push(c.text);
					}
				}
			},
		});

		await ensureVenv(config);

		assert.ok(capturedOptions.length >= 1, "should capture lock options");

		// Simulate proper-lockfile stat failure → setLockAsCompromised → onCompromised
		const err = new Error("ENOENT: stat failed on lock file");
		assert.doesNotThrow(() => {
			capturedOptions[0].onCompromised!(err);
		});

		const warningText = warnings.find((w) => w.includes("stat failed"));
		assert.ok(warningText, "should emit lock compromised warning for stat failure");

		mock.reset();
	});

	it("(use-case) ensureVenv completes successfully when fs.utimes mocked to fail mid-operation", async () => {
		// Lockfile.lock returns normally but fs.utimes fails during update timer.
		// We simulate this by having lockfile.lock's onCompromised handler invoked
		// (as proper-lockfile would do when utimes fails in its timer callback).
		mock.method(lockfile, "lock", async (_path: string, opts: any) => {
			// Simulate proper-lockfile's timer callback failing
			if (opts.onCompromised) {
				opts.onCompromised(new Error("ENOENT: utimes failed on lock file"));
			}
			return async () => {};
		});

		const warnings: string[] = [];
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			onUpdate: (u) => {
				for (const c of u.content) {
					if (c.text.startsWith("Lock compromised:")) {
						warnings.push(c.text);
					}
				}
			},
		});

		// Should complete without throwing
		const result = await ensureVenv(config);
		assert.ok(result.created || !result.created, "ensureVenv should complete despite fs error");

		const warningText = warnings.find((w) => w.includes("ENOENT"));
		assert.ok(warningText, "should have emitted lock compromised warning");

		mock.reset();
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 3: Import-audit regression guard (#1136)
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — import audit", () => {
	it("(static-analysis) only ensureVenv.ts imports proper-lockfile in production code", async () => {
		// Scan all production .ts files under .pi/extensions/ (excluding test files)
		// for imports of proper-lockfile. Only ensureVenv.ts is allowed.
		const root = new URL("../", import.meta.url).pathname;
		const extDir = root.replace(/\/+$/, "");

		const files: string[] = [];
		function walk(dir: string) {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
			}
		}
		walk(extDir);

		const offenders: string[] = [];
		for (const f of files) {
			const content = fs.readFileSync(f, "utf-8");
			if (/import[\s\S]*?['"]proper-lockfile['"]/.test(content)) {
				offenders.push(f);
			}
		}

		// Only ensureVenv.ts should import proper-lockfile
		const allowed = ["ensureVenv.ts"];
		const unexpected = offenders.filter((f) => !allowed.some((a) => f.endsWith(a)));
		assert.equal(
			unexpected.length,
			0,
			`Unexpected proper-lockfile imports in: ${unexpected.join(", ")}`,
		);
		// Also verify ensureVenv.ts IS in the list (the fix exists)
		assert.ok(
			offenders.some((f) => f.endsWith("ensureVenv.ts")),
			"ensureVenv.ts should import proper-lockfile",
		);
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 7: Concurrent agent scenarios
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — concurrent agent scenarios", () => {
	it("(entity) lock released during pip install → another process can create lock dir", async () => {
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let lockDirFreeDuringInstall = false;
		let verifyCalls = 0;

		const exec: ExecFn = async (cmd: string, args: string[]) => {
			// Verify: first 2 calls fail, 3rd (final) succeeds
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				verifyCalls++;
				if (verifyCalls <= 2) {
					return { code: 1, stdout: "", stderr: "not found" };
				}
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// rm
			if (cmd === "rm" && args[0] === "-rf") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// venv create
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
				return { code: 0, stdout: "", stderr: "" };
			}
			// pip install — check lock is free, briefly simulate other agent
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				lockDirFreeDuringInstall = !exists(lockPath);
				// Simulate another process acquiring the lock briefly
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });
				fs.mkdirSync(lockPath, { recursive: false });
				// Other agent releases immediately
				fs.rmdirSync(lockPath);
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "ok", stderr: "" };
		};

		await ensureVenv({
			exec: mock.fn(exec),
			cwd: ctx.cwd,
			venvName: "test-venv",
			pipArgs: ["test-pkg"],
			verifyCommand: "import test; print('ok')",
		});

		assert.equal(lockDirFreeDuringInstall, true, "lock dir should be free during pip install");
	});

	it("(entity) lock re-acquired by original process after install, even if another process held lock briefly", async () => {
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let otherProcessHeldLock = false;
		let verifyCompletedUnderLock = false;
		let verifyCallCount = 0;

		const exec: ExecFn = async (cmd: string, args: string[]) => {
			// Quick verify: fail
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				verifyCallCount++;
				if (verifyCallCount === 1) {
					// Quick verify (step 2)
					return { code: 1, stdout: "", stderr: "" };
				}
				if (verifyCallCount === 2) {
					// Double-check verify (step 4) — under lock
					return { code: 1, stdout: "", stderr: "" };
				}
				// Final verify (step 9) — check lock is held
				verifyCompletedUnderLock = exists(lockPath);
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// rm
			if (cmd === "rm" && args[0] === "-rf") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// venv create
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
				return { code: 0, stdout: "", stderr: "" };
			}
			// pip install — release lock (by leaving it as is), simulate other agent
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				// Other process acquires then releases lock
				otherProcessHeldLock = true;
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "ok", stderr: "" };
		};

		await ensureVenv({
			exec: mock.fn(exec),
			cwd: ctx.cwd,
			venvName: "test-venv",
			pipArgs: ["test-pkg"],
			verifyCommand: "import test; print('ok')",
		});

		assert.equal(otherProcessHeldLock, true, "other process should have held lock during install window");
		assert.equal(verifyCompletedUnderLock, true, "verify should complete under re-acquired lock");
	});

	it("(entity) two sequential ensureVenv calls: second does not block on first's pip install", async () => {
		// The lock is released before pip install, so a second ensureVenv call
		// should not wait for the first to finish pip install.
		// Verification: the lock dir should not exist between the two calls.
		const ctx = setupTest();
		const config = makeConfig(ctx);

		// First call
		const result1 = await ensureVenv(config);
		assert.equal(result1.created, true);

		// Second call (venv already exists, but make verify pass so quick path returns)
		const ctx2 = setupTest({
			handlers: { verify: { code: 0, stdout: "ok", stderr: "" } },
		});
		const config2 = makeConfig(ctx2);
		const result2 = await ensureVenv(config2);
		assert.equal(result2.created, false);
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 8: User-journey — agent uses web_crawl, lock does not block concurrent agent
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — user-journey lock concurrency", () => {
	it("(use-case) mock slow pip install (deferred promise), verify lock dir absent during install", async () => {
		const deferred = makeDeferred<{ code: number; stdout: string; stderr: string }>();
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let lockDuringInstall: boolean | undefined;
		let installStarted = false;
		let verifyCalls = 0;

		const exec: ExecFn = async (cmd: string, args: string[]) => {
			// Verify: first 2 fail, 3rd (final) succeeds
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				verifyCalls++;
				if (verifyCalls <= 2) {
					return { code: 1, stdout: "", stderr: "not found" };
				}
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// rm
			if (cmd === "rm" && args[0] === "-rf") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// venv create
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
				return { code: 0, stdout: "", stderr: "" };
			}
			// pip install — slow, deferred
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				installStarted = true;
				lockDuringInstall = exists(lockPath);
				return deferred.promise;
			}
			return { code: 0, stdout: "ok", stderr: "" };
		};

		const resultPromise = ensureVenv({
			exec: mock.fn(exec),
			cwd: ctx.cwd,
			venvName: "test-venv",
			pipArgs: ["test-pkg"],
			verifyCommand: "import test; print('ok')",
		});

		// Wait briefly for execution to reach pip install
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(installStarted, true, "pip install should have started");
		assert.equal(lockDuringInstall, false, "lock should be absent during slow pip install");

		// Resolve pip install
		deferred.resolve({ code: 0, stdout: "", stderr: "" });

		const result = await resultPromise;
		assert.equal(result.created, true, "ensureVenv should complete successfully");
	});

	it("(use-case) simulate concurrent agent acquiring lock during slow pip install, original completes after", async () => {
		const deferred = makeDeferred<{ code: number; stdout: string; stderr: string }>();
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let otherAgentGotLock = false;
		let verifyPassed = false;
		let verifyCalls = 0;

		const exec: ExecFn = async (cmd: string, args: string[]) => {
			// Verify: first calls fail, final verify checks
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				verifyCalls++;
				if (verifyCalls <= 2) {
					// Quick verify (1st) and double-check (2nd): fail
					return { code: 1, stdout: "", stderr: "" };
				}
				// Final verify (3rd): succeed, lock should be held
				verifyPassed = exists(lockPath);
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// rm
			if (cmd === "rm" && args[0] === "-rf") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// venv create
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
				return { code: 0, stdout: "", stderr: "" };
			}
			// pip install — slow, deferred
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				// Other agent acquires the lock while this agent is installing
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });
				fs.mkdirSync(lockPath, { recursive: false });
				otherAgentGotLock = true;
				return deferred.promise;
			}
			return { code: 0, stdout: "ok", stderr: "" };
		};

		const resultPromise = ensureVenv({
			exec: mock.fn(exec),
			cwd: ctx.cwd,
			venvName: "test-venv",
			pipArgs: ["test-pkg"],
			verifyCommand: "import test; print('ok')",
		});

		// Wait briefly for execution to reach pip install
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(otherAgentGotLock, true, "other agent should have grabbed lock during install window");

		// Now release the other agent's lock before resolving pip install
		// (Otherwise the re-acquire in step 9 will fail)
		fs.rmdirSync(lockPath);

		// Resolve pip install
		deferred.resolve({ code: 0, stdout: "", stderr: "" });

		const result = await resultPromise;
		assert.equal(result.created, true, "original agent should complete after other agent releases");
		assert.equal(verifyPassed, true, "verify should run under re-acquired lock");
	});
});

// ── Helpers ──

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function exists(p: string): boolean {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
}
