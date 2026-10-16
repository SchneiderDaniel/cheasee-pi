/**
 * ensureVenv — in-memory retry cache, error paths and lock-held-during-pip.
 *
 * Split from ensureVenv.test.ts (issue #2005 Long File refactor).
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
//  Phase 5: Lock held during pip install (prevents concurrent rm-rf race)
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — lock held during pip install", () => {
	it("(entity) lock dir PRESENT during pip install exec call (lock held during install)", async () => {
		let lockDuringInstall: boolean | undefined;
		const ctx = setupTest({
			callbacks: {
				onInstall: () => {
					lockDuringInstall = pathExists(lockDirPath(ctx.cwd, "test-venv"));
				},
			},
		});
		const config = makeConfig(ctx);

		await ensureVenv(config);

		assert.equal(lockDuringInstall, true, "lock should be held during pip install");
	});

	it("(entity) lock dir PRESENT during double-check → rm → create (mutation section)", async () => {
		let lockDuringCreate: boolean | undefined;
		const ctx = setupTest({
			callbacks: {
				onCreate: () => {
					lockDuringCreate = pathExists(lockDirPath(ctx.cwd, "test-venv"));
				},
			},
		});
		const config = makeConfig(ctx);

		await ensureVenv(config);

		assert.equal(lockDuringCreate, true, "lock should be held during venv creation");
	});

	it("(entity) lock dir PRESENT during postInstall hook", async () => {
		let lockDuringPostInstall: boolean | undefined;
		const ctx = setupTest();
		const config = makeConfig(ctx, {
			postInstall: async () => {
				lockDuringPostInstall = pathExists(lockDirPath(ctx.cwd, config.venvName));
			},
		});

		await ensureVenv(config);

		assert.equal(lockDuringPostInstall, true, "lock should be held during postInstall");
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
				lockDuringFinalVerify = pathExists(lockPath);
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

	it("(entity) end-to-end: acquire → create+install+postInstall (under lock) → verify → release", async () => {
		const events: Array<{ phase: string; lockHeld: boolean }> = [];
		const ctx = setupTest({
			callbacks: {
				onCreate: () => {
					events.push({ phase: "create", lockHeld: pathExists(lockDirPath(ctx.cwd, "test-venv")) });
				},
				onInstall: () => {
					events.push({
						phase: "install",
						lockHeld: pathExists(lockDirPath(ctx.cwd, "test-venv")),
					});
				},
			},
		});
		const config = makeConfig(ctx, {
			postInstall: async () => {
				events.push({
					phase: "postInstall",
					lockHeld: pathExists(lockDirPath(ctx.cwd, config.venvName)),
				});
			},
		});

		await ensureVenv(config);

		// Create under lock
		const createEvent = events.find((e) => e.phase === "create");
		assert.ok(createEvent, "create event should have fired");
		assert.equal(createEvent!.lockHeld, true, "lock should be held during create");

		// Install under lock
		const installEvent = events.find((e) => e.phase === "install");
		assert.ok(installEvent, "install event should have fired");
		assert.equal(installEvent!.lockHeld, true, "lock should be held during install");

		// PostInstall under lock
		const postInstallEvent = events.find((e) => e.phase === "postInstall");
		assert.ok(postInstallEvent, "postInstall event should have fired");
		assert.equal(postInstallEvent!.lockHeld, true, "lock should be held during postInstall");

		// After completion, lock should be released
		assert.equal(
			pathExists(lockDirPath(ctx.cwd, "test-venv")),
			false,
			"lock should be released after completion",
		);
	});
});
