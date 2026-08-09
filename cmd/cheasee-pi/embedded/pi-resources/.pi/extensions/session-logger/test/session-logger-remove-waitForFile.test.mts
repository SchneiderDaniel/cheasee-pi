/**
 * Tests verifying dead code removal: waitForFile & WaitForFileOptions
 *
 * waitForFile / WaitForFileOptions were dead code — exported from files.ts but
 * never imported or called in any production code. Only their own test file
 * referenced them.
 *
 * TDD approach: These tests must FAIL when waitForFile/WaitForFileOptions
 * still exist in files.ts, and PASS after they are removed.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-remove-waitForFile.test.mts
 */

import assert from "node:assert";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";

describe("waitForFile dead code removal", () => {
	// After removal: importing waitForFile from files.ts should be undefined
	it("waitForFile should NOT be exported from files.ts (dead code — no production callers)", async () => {
		const mod = await import("../files.ts");
		const modAny = mod as Record<string, unknown>;
		assert.strictEqual(
			typeof modAny.waitForFile,
			"undefined",
			"waitForFile must be removed — it had zero production callers",
		);
	});

	// Confirm no collateral damage — adjacent exports must still be intact
	it("ensureSymlink should still be exported from files.ts", async () => {
		const mod = await import("../files.ts");
		assert.strictEqual(typeof mod.ensureSymlink, "function");
	});

	it("createAtomicSymlink should still be exported from files.ts", async () => {
		const mod = await import("../files.ts");
		assert.strictEqual(typeof mod.createAtomicSymlink, "function");
	});
});

describe("orphaned test file deletion", () => {
	// The orphaned test file was the ONLY consumer of waitForFile and
	// WaitForFileOptions. Once both are removed, the file should no longer exist.
	it("session-logger-waitForFile.test.mts should be deleted (only consumer of dead code)", async () => {
		// Use fs.stat to verify file doesn't exist — fs.stat rejects with ENOENT
		// when the file is missing, which we assert.rejects catches.
		await assert.rejects(
			async () => {
				await fs.stat(new URL("./session-logger-waitForFile.test.mts", import.meta.url));
			},
			{ code: "ENOENT" },
			"orphaned test file must be deleted along with dead code",
		);
	});
});
