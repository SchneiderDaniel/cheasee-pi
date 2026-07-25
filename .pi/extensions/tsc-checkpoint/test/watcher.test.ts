/**
 * Tests for watcher.ts — DiagnosticsWatcher (consolidated tsc-binding watcher).
 *
 * Phase 2: Entity tests (no I/O, using _injectDiagnostics) + integration smoke
 * tests (real temp tsconfig fixture).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/watcher.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { DiagnosticsWatcher } from "../watcher.ts";
import type { TscDiagnostic } from "../types.ts";

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — Entity tests (no I/O)
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (entity)", () => {
	it("is a class constructor", () => {
		assert.strictEqual(typeof DiagnosticsWatcher, "function");
	});

	it("constructor stores tsconfigPath", () => {
		const w = new DiagnosticsWatcher("/some/path/tsconfig.json");
		assert.strictEqual(w.tsconfigPathValue, "/some/path/tsconfig.json");
	});

	it("isRunning() returns false initially", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		assert.strictEqual(w.isRunning(), false);
	});

	it("getDiagnostics() returns [] before any diagnostic event", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		assert.deepStrictEqual(w.getDiagnostics(), []);
	});

	it("start() with non-existent tsconfig throws", () => {
		const w = new DiagnosticsWatcher("/nonexistent/tsconfig.json");
		assert.throws(() => w.start(), {
			message: /tsconfig not found/,
		});
	});

	it("stop() when not running is no-op", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		w.stop(); // should not throw
		assert.strictEqual(w.isRunning(), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — _injectDiagnostics test-only mechanism
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (_injectDiagnostics)", () => {
	it("_injectDiagnostics populates cached diagnostics", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
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
		w._injectDiagnostics(diags);
		assert.strictEqual(w.getDiagnostics().length, 1);
		assert.strictEqual(w.getDiagnostics()[0]!.code, "TS2322");
	});

	it("getDiagnostics() returns a copy (not same reference)", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				code: "TS1000",
				filePath: "/a.ts",
			},
		];
		w._injectDiagnostics(diags);
		const result = w.getDiagnostics();
		assert.notStrictEqual(result, diags);
	});

	it("onDiagnosticsChange listener fires after _injectDiagnostics", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		let fired = false;
		let received: TscDiagnostic[] | undefined;
		w.onDiagnosticsChange((d) => {
			fired = true;
			received = d;
		});

		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				code: "TS1000",
				filePath: "/a.ts",
			},
		];
		w._injectDiagnostics(diags);

		assert.strictEqual(fired, true);
		assert.strictEqual(received!.length, 1);
	});

	it("multiple onDiagnosticsChange listeners all fire", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		let count = 0;
		w.onDiagnosticsChange(() => count++);
		w.onDiagnosticsChange(() => count++);

		w._injectDiagnostics([]);
		assert.strictEqual(count, 2);
	});

	it("_injectDiagnostics updates trend via error count", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
		]);
		assert.strictEqual(w.getTrend(), undefined); // still < 2

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
			{
				file: "b.ts",
				line: 2,
				column: 2,
				severity: "Error",
				message: "err2",
				filePath: "/b.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "regressed");
		assert.strictEqual(trend!.current, 2);
		assert.strictEqual(trend!.previous, 1);
	});

	it("getTrend() returns undefined after single _injectDiagnostics call", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		w._injectDiagnostics([]);
		assert.strictEqual(w.getTrend(), undefined);
	});

	it("getTrend() shows improved when error count decreases", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "e1",
				filePath: "/a.ts",
			},
			{
				file: "b.ts",
				line: 2,
				column: 2,
				severity: "Error",
				message: "e2",
				filePath: "/b.ts",
			},
		]);

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "e1",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "improved");
		assert.strictEqual(trend!.delta, 1);
	});

	it("getTrend() shows stable when error count unchanged", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "e",
				filePath: "/a.ts",
			},
		]);

		w._injectDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "e",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — Integration smoke tests (real tsconfig fixture)
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (integration smoke)", () => {
	function makeFixture(): { dir: string; w: DiagnosticsWatcher; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "tsc-watcher-int-"));
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { noEmit: true, strict: true },
				include: ["src/**/*.ts"],
			}),
			"utf-8",
		);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "index.ts"), 'export const x: number = "string";\n', "utf-8");
		const w = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
		const cleanup = () => {
			w.stop();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		};
		return { dir, w, cleanup };
	}

	it("start() against real tsconfig returns true, isRunning = true", () => {
		const { w, cleanup } = makeFixture();
		try {
			const result = w.start();
			assert.strictEqual(result, true);
			assert.strictEqual(w.isRunning(), true);
		} finally {
			w.stop();
			cleanup();
		}
	});

	it("start() twice returns false, watcher still running", () => {
		const { w, cleanup } = makeFixture();
		try {
			w.start();
			const result = w.start();
			assert.strictEqual(result, false);
			assert.strictEqual(w.isRunning(), true);
		} finally {
			w.stop();
			cleanup();
		}
	});

	it("stop() after successful start sets isRunning false", () => {
		const { w, cleanup } = makeFixture();
		try {
			w.start();
			assert.strictEqual(w.isRunning(), true);
			w.stop();
			assert.strictEqual(w.isRunning(), false);
		} finally {
			cleanup();
		}
	});

	it("cached diagnostics survive stop", () => {
		const { dir, w, cleanup } = makeFixture();
		try {
			// Use _injectDiagnostics to populate diagnostics without async wait
			const sampleDiags: TscDiagnostic[] = [
				{
					file: "src/index.ts",
					line: 1,
					column: 7,
					severity: "Error",
					message: "Type 'string' is not assignable to type 'number'.",
					code: "TS2322",
					filePath: join(dirname(join(dir, "tsconfig.json")), "src/index.ts"),
				},
			];
			w._injectDiagnostics(sampleDiags);
			const beforeStop = w.getDiagnostics();
			assert.strictEqual(beforeStop.length, 1);

			w.stop();
			const afterStop = w.getDiagnostics();
			assert.strictEqual(w.isRunning(), false);
			assert.deepStrictEqual(afterStop, beforeStop, "cached diagnostics should survive stop");
		} finally {
			cleanup();
		}
	});

	it("start() + stop() + start() restarts watcher correctly", () => {
		const { w, cleanup } = makeFixture();
		try {
			assert.strictEqual(w.start(), true);
			assert.strictEqual(w.isRunning(), true);

			w.stop();
			assert.strictEqual(w.isRunning(), false);

			assert.strictEqual(w.start(), true);
			assert.strictEqual(w.isRunning(), true);
		} finally {
			w.stop();
			cleanup();
		}
	});

	it("start against clean fixture (no errors) — stops cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "tsc-watcher-clean-"));
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					include: ["src/**/*.ts"],
				}),
				"utf-8",
			);
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "index.ts"), 'export const x: number = 1;\n', "utf-8");

			const w = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
			w.start();
			assert.strictEqual(w.isRunning(), true);
			w.stop();
			assert.strictEqual(w.isRunning(), false);
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});
});
