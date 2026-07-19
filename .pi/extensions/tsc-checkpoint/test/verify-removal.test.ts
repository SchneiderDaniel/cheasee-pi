/**
 * Verification tests for formatTrend removal.
 *
 * Phase 1: Verify dead code (formatTrend) is removed from both format.ts
 * and index.ts. Uses only dynamic import() — no static imports of the
 * removed symbol.
 *
 * These tests fail BEFORE removal and pass AFTER removal.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/verify-removal.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("formatTrend removed from format.ts", () => {
	it("formatTrend is not exported from format.ts", async () => {
		const mod = await import("../format.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>).formatTrend,
			undefined,
			"formatTrend should be removed from format.ts exports",
		);
	});

	it("formatDiagnostics is still exported from format.ts", async () => {
		const mod = await import("../format.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnostics, "function");
	});

	it("formatDiagnosticsJson is still exported from format.ts", async () => {
		const mod = await import("../format.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnosticsJson, "function");
	});
});

describe("formatTrend removed from index.ts", () => {
	it("formatTrend is not exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>).formatTrend,
			undefined,
			"formatTrend should be removed from index.ts re-exports",
		);
	});

	it("formatDiagnostics is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnostics, "function");
	});

	it("formatDiagnosticsJson is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).formatDiagnosticsJson, "function");
	});

	it("diagnosticToTscDiagnostic is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).diagnosticToTscDiagnostic, "function");
	});

	it("resolveDiagnosticFilePath is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).resolveDiagnosticFilePath, "function");
	});

	it("DiagnosticsWatcher is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).DiagnosticsWatcher, "function");
	});

	it("runTscCheckpoint is still re-exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof (mod as Record<string, unknown>).runTscCheckpoint, "function");
	});
});
