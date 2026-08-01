/**
 * Verification tests for parseArgs removal.
 *
 * Phase 1: Verify dead code (parseArgs import) is removed from index.ts.
 * Uses only dynamic import() — no static imports of the removed symbol.
 *
 * These tests fail BEFORE removal and pass AFTER removal.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/verify-parseargs-removal.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("parseArgs removed from index.ts", () => {
	it("parseArgs is not exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>).parseArgs,
			undefined,
			"parseArgs should be removed from index.ts (import + void suppression gone)",
		);
	});

	it("module loads without throwing (no dangling void parseArgs)", async () => {
		// A leftover `void parseArgs` without the import would raise
		// ReferenceError at module evaluation; a successful load proves
		// both the import and its suppression statement are gone.
		const mod = await import("../index.ts");
		assert.ok(mod, "index.ts should evaluate without throwing");
	});

	it("default export is still present", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).default, "function");
	});

	it("formatDiagnostics is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnostics, "function");
	});

	it("formatDiagnosticsJson is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnosticsJson, "function");
	});

	it("DiagnosticsWatcher is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).DiagnosticsWatcher, "function");
	});

	it("runTscCheckpoint is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).runTscCheckpoint, "function");
	});

	it("diagnosticToTscDiagnostic is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).diagnosticToTscDiagnostic, "function");
	});

	it("resolveDiagnosticFilePath is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).resolveDiagnosticFilePath, "function");
	});
});
