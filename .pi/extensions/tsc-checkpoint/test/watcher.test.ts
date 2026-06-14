/**
 * Tests for watcher.ts — DiagnosticsWatcher lifecycle, trend computation,
 * listener registration, adapter delegation.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/watcher.test.ts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { resolve } from "node:path";

import { DiagnosticsWatcher } from "../watcher.ts";
import type { TscDiagnostic } from "../types.ts";
import { MockAdapter } from "./shared.ts";

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — Lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (lifecycle)", () => {
	it("is a class constructor", () => {
		assert.strictEqual(typeof DiagnosticsWatcher, "function");
	});

	it("stores tsconfigPath and sets watchOptions to defaults", () => {
		const w = new DiagnosticsWatcher("/some/path/tsconfig.json");
		assert.strictEqual(w.tsconfigPathValue, "/some/path/tsconfig.json");
		assert.deepStrictEqual(w.watchOptionsValue, {});
	});

	it("stores custom TscWatchOptions", () => {
		const w = new DiagnosticsWatcher("/path/tsconfig.json", {
			pollInterval: 5000,
		});
		assert.strictEqual(w.watchOptionsValue.pollInterval, 5000);
	});

	it("start() with non-existent tsconfig throws", () => {
		const w = new DiagnosticsWatcher("/nonexistent/tsconfig.json");
		assert.throws(() => w.start(), {
			message: /tsconfig not found/,
		});
	});

	it("start() once returns true, isRunning() returns true", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		const result = w.start();
		assert.strictEqual(result, true);
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("start() twice returns false, isRunning() stays true", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		const result = w.start();
		assert.strictEqual(result, false);
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("stop() closes watch, isRunning() returns false", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		assert.strictEqual(w.isRunning(), true);
		w.stop();
		assert.strictEqual(w.isRunning(), false);
		assert.strictEqual(adapter.stopCalls, 1);
	});

	it("stop() when not running is no-op", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.stop(); // not started
		assert.strictEqual(adapter.stopCalls, 0);
		assert.strictEqual(w.isRunning(), false);
	});

	it("getDiagnostics() before any event returns []", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		assert.deepStrictEqual(w.getDiagnostics(), []);
	});

	it("getDiagnostics() after watcher reports errors returns cached diagnostics", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		const sampleDiags: TscDiagnostic[] = [
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
		adapter.emitDiagnostics(sampleDiags);

		const result = w.getDiagnostics();
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.code, "TS2322");
	});

	it("stop() then start() restarts watcher correctly", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);

		w.start();
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);

		w.stop();
		assert.strictEqual(w.isRunning(), false);
		assert.strictEqual(adapter.stopCalls, 1);

		w.start();
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// MockAdapter — shared test utility export check
// ═══════════════════════════════════════════════════════════════════════

describe("MockAdapter (shared test utility)", () => {
	it("is a class implementing TscWatchAdapter", () => {
		assert.strictEqual(typeof MockAdapter, "function");
		const instance = new MockAdapter();
		assert.strictEqual(typeof instance.start, "function");
		assert.strictEqual(typeof instance.stop, "function");
		assert.strictEqual(typeof instance.isRunning, "function");
		assert.strictEqual(typeof instance.getDiagnostics, "function");
		assert.strictEqual(typeof instance.onDiagnosticsChange, "function");
	});

	it("emitDiagnostics triggers registered listeners", () => {
		const adapter = new MockAdapter();
		let received: TscDiagnostic[] | undefined;
		adapter.onDiagnosticsChange((d) => {
			received = d;
		});
		adapter.emitDiagnostics([]);
		assert.ok(Array.isArray(received));
	});

	it("setShouldFailStart causes start() to throw", () => {
		const adapter = new MockAdapter();
		adapter.setShouldFailStart(true);
		assert.throws(() => adapter.start("/path/tsconfig.json"), {
			message: /tsconfig not found/,
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — Incremental cache & listener registration
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (incremental re-check & cache)", () => {
	let adapter: MockAdapter;
	let watcher: DiagnosticsWatcher;

	beforeEach(() => {
		adapter = new MockAdapter();
		watcher = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		watcher.start();
	});

	it("file-change triggers watcher callback → onDiagnosticsChange fires with new diagnostics", () => {
		let changeFired = false;
		let receivedDiags: TscDiagnostic[] | undefined;

		watcher.onDiagnosticsChange((diags) => {
			changeFired = true;
			receivedDiags = diags;
		});

		const newDiags: TscDiagnostic[] = [
			{
				file: "src/new.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "New error",
				code: "TS2304",
				filePath: "/project/src/new.ts",
			},
		];
		adapter.emitDiagnostics(newDiags);

		assert.strictEqual(changeFired, true);
		assert.strictEqual(receivedDiags!.length, 1);
		assert.strictEqual(receivedDiags![0]!.code, "TS2304");
	});

	it("getDiagnostics() called twice with no file changes returns same array reference (cached)", () => {
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
		adapter.emitDiagnostics(diags);

		const first = watcher.getDiagnostics();
		const second = watcher.getDiagnostics();

		assert.strictEqual(first, second);
		assert.strictEqual(first.length, 1);
	});

	it("new file with error added → updated diagnostics", () => {
		const initialDiags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "Error A",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
		];
		adapter.emitDiagnostics(initialDiags);
		assert.strictEqual(watcher.getDiagnostics().length, 1);

		const updatedDiags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "Error A",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
			{
				file: "src/b.ts",
				line: 5,
				column: 3,
				severity: "Error",
				message: "Error B",
				code: "TS2304",
				filePath: "/project/src/b.ts",
			},
		];
		adapter.emitDiagnostics(updatedDiags);
		assert.strictEqual(watcher.getDiagnostics().length, 2);
		assert.strictEqual(watcher.getDiagnostics()[1]!.code, "TS2304");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher — Trend Tracking
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (trend tracking)", () => {
	it("getTrend() returns undefined when fewer than 2 data points", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		assert.strictEqual(w.getTrend(), undefined);

		// One diagnostic emission
		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);
		assert.strictEqual(w.getTrend(), undefined); // Still only 1
	});

	it("getTrend() shows regression when error count increases", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		// First check: 1 error
		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
		]);

		// Second check: 3 errors
		adapter.emitDiagnostics([
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
			{
				file: "c.ts",
				line: 3,
				column: 3,
				severity: "Error",
				message: "err3",
				filePath: "/c.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.current, 3);
		assert.strictEqual(trend!.previous, 1);
		assert.strictEqual(trend!.direction, "regressed");
		assert.strictEqual(trend!.delta, 2);
	});

	it("getTrend() shows improvement when error count decreases", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		adapter.emitDiagnostics([
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

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.current, 1);
		assert.strictEqual(trend!.previous, 2);
		assert.strictEqual(trend!.direction, "improved");
		assert.strictEqual(trend!.delta, 1);
	});

	it("getTrend() shows stable when error count unchanged", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);
	});
});
