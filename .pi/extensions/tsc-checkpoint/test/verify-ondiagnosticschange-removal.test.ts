/**
 * Verification tests for onDiagnosticsChange removal.
 *
 * Phase 1: Verify dead code (onDiagnosticsChange listener infra) is removed
 * from watcher.ts. Uses only dynamic import() — no static imports of the
 * removed symbol.
 *
 * These tests fail BEFORE removal and pass AFTER removal.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/verify-ondiagnosticschange-removal.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("onDiagnosticsChange removed from DiagnosticsWatcher", () => {
	it("DiagnosticsWatcher.prototype.onDiagnosticsChange is undefined", async () => {
		const mod = await import("../watcher.ts");
		const cls = (mod as Record<string, unknown>).DiagnosticsWatcher as {
			prototype: Record<string, unknown>;
		};
		assert.strictEqual(
			cls.prototype.onDiagnosticsChange,
			undefined,
			"onDiagnosticsChange should be removed from the prototype",
		);
	});

	it("DiagnosticsWatcher.prototype.notifyListeners is undefined (no zombie private method)", async () => {
		const mod = await import("../watcher.ts");
		const cls = (mod as Record<string, unknown>).DiagnosticsWatcher as {
			prototype: Record<string, unknown>;
		};
		assert.strictEqual(
			cls.prototype.notifyListeners,
			undefined,
			"notifyListeners should be removed from the prototype",
		);
	});

	it("instances no longer carry a diagnosticListeners field", async () => {
		const mod = await import("../watcher.ts");
		const cls = mod.DiagnosticsWatcher as unknown as new (
			path: string,
		) => Record<string, unknown>;
		const w = new cls("/fake/tsconfig.json");
		assert.strictEqual(
			w.diagnosticListeners,
			undefined,
			"diagnosticListeners field should be removed",
		);
	});

	it("watcher.ts loads without throwing (no dangling references)", async () => {
		const mod = await import("../watcher.ts");
		assert.ok(mod, "watcher.ts should evaluate without throwing");
	});

	it("re-exported DiagnosticsWatcher from index.ts also lacks the method", async () => {
		const mod = await import("../index.ts");
		const cls = (mod as Record<string, unknown>).DiagnosticsWatcher as {
			prototype: Record<string, unknown>;
		};
		assert.strictEqual(typeof cls, "function", "DiagnosticsWatcher still re-exported");
		assert.strictEqual(cls.prototype.onDiagnosticsChange, undefined);
	});

	it("index.ts loads without throwing", async () => {
		const mod = await import("../index.ts");
		assert.ok(mod, "index.ts should evaluate without throwing");
	});
});

describe("retained DiagnosticsWatcher pull API (guards against over-removal)", () => {
	it("prototype still exposes start/stop/getDiagnostics/getTrend/isRunning", async () => {
		const mod = await import("../watcher.ts");
		const cls = (mod as Record<string, unknown>).DiagnosticsWatcher as {
			prototype: Record<string, unknown>;
		};
		for (const method of ["start", "stop", "getDiagnostics", "getTrend", "isRunning"]) {
			assert.strictEqual(
				typeof cls.prototype[method],
				"function",
				`${method} should be retained on the prototype`,
			);
		}
	});

	it("instances still expose the tsconfigPathValue getter", async () => {
		const mod = await import("../watcher.ts");
		const cls = mod.DiagnosticsWatcher as unknown as new (
			path: string,
		) => Record<string, unknown>;
		const w = new cls("/fake/tsconfig.json");
		assert.strictEqual(w.tsconfigPathValue, "/fake/tsconfig.json");
	});
});
