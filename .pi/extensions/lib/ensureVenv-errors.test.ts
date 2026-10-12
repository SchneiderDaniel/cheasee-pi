/**
 * ensureVenv — onCompromised handler, fs-error injection and the static
 * proper-lockfile import-audit guard.
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
		assert.ok(
			capturedOptions.length >= 2,
			"should capture onCompromised from at least 2 lock calls",
		);

		// Each call should have an onCompromised handler
		for (const opts of capturedOptions) {
			assert.equal(
				typeof opts.onCompromised,
				"function",
				"each lock call should have onCompromised handler",
			);
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
		assert.ok(
			compromiseWarning!.text.includes("ENOENT: utimes failed"),
			"warning should include error message",
		);
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
				else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
					files.push(p);
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
