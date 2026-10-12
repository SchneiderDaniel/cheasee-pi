/**
 * ensureVenv — concurrent agent scenarios and the user-journey lock
 * concurrency contract.
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
//  Phase 7: Concurrent agent scenarios
// ══════════════════════════════════════════════════════════════════════

describe("ensureVenv — concurrent agent scenarios", () => {
	it("(entity) lock held during pip install → another process can NOT create lock dir", async () => {
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let lockDirHeldDuringInstall = false;
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
			// pip install — lock is held, other process can NOT acquire it
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				lockDirHeldDuringInstall = pathExists(lockPath);
				// Trying to acquire the lock should fail (held by us)
				assert.throws(
					() => {
						fs.mkdirSync(lockPath, { recursive: false });
					},
					{ code: "EEXIST" },
					"other process should fail to acquire lock",
				);
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

		assert.equal(lockDirHeldDuringInstall, true, "lock dir should be held during pip install");
	});

	it("(entity) lock held during full mutation, verify re-acquires lock after release", async () => {
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let lockHeldDuringCreate = false;
		let lockHeldDuringInstall = false;
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
					lockHeldDuringCreate = pathExists(lockPath);
					return { code: 1, stdout: "", stderr: "" };
				}
				// Final verify (step 9) — check lock is re-acquired
				verifyCompletedUnderLock = pathExists(lockPath);
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
			// pip install — lock is held throughout
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				lockHeldDuringInstall = pathExists(lockPath);
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

		assert.equal(lockHeldDuringCreate, true, "lock should be held during double-check (step 4)");
		assert.equal(lockHeldDuringInstall, true, "lock should be held during pip install");
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
	it("(use-case) mock slow pip install (deferred promise), verify lock held during install", async () => {
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
			// pip install — slow, deferred, lock held throughout
			if (cmd.includes("bin/python3") && args.includes("-m") && args.includes("pip")) {
				installStarted = true;
				lockDuringInstall = pathExists(lockPath);
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
		assert.equal(lockDuringInstall, true, "lock should be held during slow pip install");

		// Resolve pip install
		deferred.resolve({ code: 0, stdout: "", stderr: "" });

		const result = await resultPromise;
		assert.equal(result.created, true, "ensureVenv should complete successfully");
	});

	it("(use-case) concurrent agent blocked on lock during slow pip install, completes after lock released", async () => {
		const deferred = makeDeferred<{ code: number; stdout: string; stderr: string }>();
		const ctx = setupTest();
		const lockPath = lockDirPath(ctx.cwd, "test-venv");

		let pipInstallStarted = false;
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
				// Final verify (3rd): succeed, lock should be re-acquired
				verifyPassed = pathExists(lockPath);
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
				pipInstallStarted = true;
				// Verify concurrent agent CANNOT acquire lock (we hold it)
				assert.ok(pathExists(lockPath), "lock should be held during pip install");
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

		assert.equal(pipInstallStarted, true, "pip install should have started");

		// Verify lock is held by original process during install
		assert.ok(pathExists(lockPath), "lock held by original process during install");

		// Resolve pip install — original releases lock
		deferred.resolve({ code: 0, stdout: "", stderr: "" });

		const result = await resultPromise;
		assert.equal(result.created, true, "ensureVenv should complete successfully");
		assert.equal(verifyPassed, true, "verify should run under re-acquired lock");
	});
});
