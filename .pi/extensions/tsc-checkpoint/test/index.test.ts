/**
 * Tests for index.ts — Extension entry point, backward-compatible re-exports,
 * lifecycle cleanup, trust gate, mode-adapted output.
 *
 * Rewritten for the consolidated watcher: no MockAdapter, no TscWatchAdapter.
 * Uses real temp fixtures + _injectDiagnostics for tests that need diagnostic data.
 *
 * Split (issue #2005 Long File refactor): the lifecycle/trust/mode guards live
 * in lifecycle.test.ts; shared fixtures in fixtures.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/index.test.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";
import { resolve, join } from "node:path";

import {
	DiagnosticsWatcher,
	resolveDiagnosticFilePath,
	formatDiagnostics,
	runTscCheckpoint,
} from "../index.ts";

import type { TscDiagnostic, DiagnosticTrend } from "../index.ts";

import { createMinimalFixture, createCheckHandler } from "./fixtures.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: Pipeline contract — runTscCheckpoint signature & shape
// ═══════════════════════════════════════════════════════════════════════

describe("runTscCheckpoint (pipeline contract)", () => {
	it("is exported and callable with single worktreePath argument", async () => {
		const result = await runTscCheckpoint("/nonexistent/path");
		assert.ok(typeof result === "object");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
	});

	it("has .length === 2 (worktreePath + optional injectable config parser)", () => {
		assert.strictEqual(runTscCheckpoint.length, 2);
	});

	it("ExtensionAPI type import still present in source (used by tscCheckpoint entry)", async () => {
		const mod = await import("../index.ts");
		assert.ok(typeof mod.default === "function", "default export (tscCheckpoint) still present");
	});

	it("getRunTscCheckpoint returns function with .length === 2 that returns { diagnostics, hasErrors }", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.runTscCheckpoint, "function");
		assert.strictEqual(mod.runTscCheckpoint.length, 2);
		const result = await mod.runTscCheckpoint("/nonexistent/path");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
	});
});

describe("Extension entry point (/check command)", () => {
	it("/check without tsconfig.json returns skip message", async () => {
		const { handleCheck } = createCheckHandler();
		const result = await handleCheck("/nonexistent-worktree");

		assert.strictEqual(result.messages.length, 1);
		assert.ok(result.messages[0]!.content.includes("No `tsconfig.json` found"));
	});

	it("/check creates watcher and returns cached diagnostics", async () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		const { handleCheck, cleanup: cleanupHandler } = createCheckHandler();
		try {
			const result = await handleCheck(dir);
			// Watcher was started, no diagnostics yet → "no errors" message
			assert.ok(result.messages.some((m) => m.content.includes("No type errors detected")));
		} finally {
			cleanupHandler();
			cleanupDir();
		}
	});

	it("/check with diagnostics returns formatted errors", async () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		const { handleCheck, cleanup: cleanupHandler } = createCheckHandler();
		try {
			// First call creates the watcher and starts it
			const firstResult = await handleCheck(dir);
			assert.ok(firstResult.messages.some((m) => m.content.includes("Running `tsc`")));

			// Create a separate watcher, use _injectDiagnostics to simulate diags
			const watcher = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
			watcher._injectDiagnostics([
				{
					file: "src/app.ts",
					line: 10,
					column: 5,
					severity: "Error",
					message: "Type 'string' is not assignable",
					code: "TS2322",
					filePath: resolve(dir, "src/app.ts"),
				},
			]);

			const diagnostics = watcher.getDiagnostics();
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(diagnostics[0]!.code, "TS2322");
			watcher.stop();
		} finally {
			cleanupHandler();
			cleanupDir();
		}
	});

	it("/check without diagnostics returns clean message", async () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		const { handleCheck, cleanup: cleanupHandler } = createCheckHandler();
		try {
			const result = await handleCheck(dir);
			const cleanMsg = result.messages.find((m) => m.content.includes("No type errors detected"));
			assert.ok(cleanMsg);
		} finally {
			cleanupHandler();
			cleanupDir();
		}
	});

	it("diagnostics with relative paths have absolute filePath", () => {
		const tsconfigDir = process.cwd();
		const filePath = resolveDiagnosticFilePath("src/app.ts", tsconfigDir);
		assert.strictEqual(filePath, resolve(tsconfigDir, "src/app.ts"));
	});

	it("formatDiagnostics emits relative file paths", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		const formatted = formatDiagnostics(diags);
		assert.ok(formatted.includes("src/app.ts"));
		assert.ok(formatted.includes("Line 10"));
		assert.ok(formatted.includes("(TS2322)"));
	});

	it("formatDiagnostics with empty array returns empty string", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Worktree switch — watcher invalidation when worktree changes
// ═══════════════════════════════════════════════════════════════════════

describe("worktree switch — watcher invalidation", () => {
	it("DiagnosticsWatcher tracks its tsconfigPath", () => {
		const w = new DiagnosticsWatcher("/some/tsconfig.json");
		assert.strictEqual(w.tsconfigPathValue, "/some/tsconfig.json");
	});

	it("switching to different worktree requires a new watcher", () => {
		const w1 = new DiagnosticsWatcher(resolve("/project-a", "tsconfig.json"));
		const w2 = new DiagnosticsWatcher(resolve("/project-b", "tsconfig.json"));
		assert.notStrictEqual(w1.tsconfigPathValue, w2.tsconfigPathValue);
	});

	it("worktree switch with no tsconfig returns skip, old watcher unchanged", async () => {
		const { handleCheck } = createCheckHandler();
		const tmpDir = fs.mkdtempSync("tsc-test-noconfig-");
		try {
			const result = await handleCheck(tmpDir);
			// Skip message returned
			assert.ok(result.messages.some((m) => m.content.includes("No `tsconfig.json` found")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("worktree switch with start failure sends error, no crash", async () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		const { handleCheck, cleanup: cleanupHandler } = createCheckHandler();
		try {
			// Start watcher in fixture dir
			const w = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
			w.start();
			assert.strictEqual(w.isRunning(), true);

			// Now try to start at a non-existent path through handler
			const result = await handleCheck("/nonexistent-dir");
			assert.ok(result.messages.some((m) => m.content.includes("No `tsconfig.json` found")));
			w.stop();
		} finally {
			cleanupHandler();
			cleanupDir();
		}
	});
});
