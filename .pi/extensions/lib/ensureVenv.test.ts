/**
 * Tests for ensureVenv — shared venv setup utility.
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 *
 * Covers: core flow, lock behavior, lock lifecycle logging.
 * Split (issue #2005 Long File refactor): retry cache + error paths in
 * ensureVenv-retry.test.ts, fs-error + import-audit guards in
 * ensureVenv-errors.test.ts, concurrency scenarios in
 * ensureVenv-concurrency.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureVenv, EnsureVenvError } from "./ensureVenv.ts";
import type { ExecFn } from "./port-types.ts";
import type { EnsureVenvConfig } from "./ensureVenv.ts";
import lockfile from "proper-lockfile";

import {
	lockDirPath,
	makeMockExec,
	setupTest,
	makeConfig,
	makeDeferred,
	pathExists,
	DEFAULT_HANDLERS,
} from "./test/ensureVenv-fixtures.ts";

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
		assert.ok(!pathExists(lockPath), "lock should not exist before setup");

		await ensureVenv(config);

		assert.ok(!pathExists(lockPath), "lock should be removed after setup");
	});

	it("(entity) lock released in finally when pip install throws", async () => {
		const ctx = setupTest({
			handlers: { install: { code: 1, stdout: "", stderr: "pip failed" } },
		});
		const config = makeConfig(ctx);

		const lockPath = lockDirPath(ctx.cwd, config.venvName);

		await assert.rejects(() => ensureVenv(config));

		assert.ok(!pathExists(lockPath), "lock should be removed after error");
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

		assert.ok(!pathExists(lockPath), "lock should be removed after postInstall error");
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
		assert.ok(!pathExists(lockPath), "stale lock should be removed");
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
		assert.ok(!pathExists(lockPath), "old lock dir should be removed");
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
