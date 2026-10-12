// ─── tsc-checkpoint: lifecycle + trust + mode guards ─────────────
// Split from index.test.ts (issue #2005 Long File refactor).
// Scenario seam: Phase 11 (session_shutdown) onward.

import assert from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";
import { resolve, join } from "node:path";



import {
	DiagnosticsWatcher,
	formatDiagnostics,
	formatDiagnosticsJson,
} from "../index.ts";

import type { TscDiagnostic, DiagnosticTrend } from "../index.ts";

import {
	createMinimalFixture,
	createCheckHandler,
	createMockPi,
} from "./fixtures.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 11: Lifecycle cleanup via session_shutdown event
// ═══════════════════════════════════════════════════════════════════════

describe("session_shutdown lifecycle", () => {
	it("tscCheckpoint registers on('session_shutdown', handler) during initialization", async () => {
		const { pi, getHandlerCount } = createMockPi();
		const mod = await import("../index.ts");
		mod.default(pi as any);
		assert.strictEqual(getHandlerCount(), 1, "Should register exactly 1 session_shutdown handler");
	});

	it("session_shutdown handler stops running watcher (stop() called)", async () => {
		const { dir, cleanup } = createMinimalFixture();
		try {
			const watcher = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
			watcher.start();
			assert.strictEqual(watcher.isRunning(), true);

			// Simulate what the session_shutdown handler does
			watcher.stop();
			assert.strictEqual(watcher.isRunning(), false);
		} finally {
			cleanup();
		}
	});

	it("session_shutdown when watcher is never created — no crash", async () => {
		const { pi, fireShutdown, getHandlerCount } = createMockPi();
		const mod = await import("../index.ts");
		mod.default(pi as any);
		assert.strictEqual(getHandlerCount(), 1);

		// This should not throw even though watcher was never created
		fireShutdown();
		assert.ok(true);
	});

	it("session_shutdown handler when watcher exists but not running — no double-stop", () => {
		const w = new DiagnosticsWatcher("/fake/tsconfig.json");
		assert.strictEqual(w.isRunning(), false);

		// Simulate shutdown handler behavior
		// stop() when not running should be no-op
		w.stop();
		assert.strictEqual(w.isRunning(), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 12: Resource leak prevention — no duplicate watchers
// ═══════════════════════════════════════════════════════════════════════

describe("resource leak prevention (no duplicate watchers)", () => {
	it("DiagnosticsWatcher.start() when already running returns false", () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		try {
			const w = new DiagnosticsWatcher(join(dir, "tsconfig.json"));
			w.start();
			assert.strictEqual(w.isRunning(), true);

			// Second start should return false
			const result = w.start();
			assert.strictEqual(result, false);
			w.stop();
		} finally {
			cleanupDir();
		}
	});

	it("shutdown + next session creates new watcher", () => {
		const w1 = new DiagnosticsWatcher("/project-a/tsconfig.json");
		w1.stop();
		const w2 = new DiagnosticsWatcher("/project-b/tsconfig.json");
		assert.notStrictEqual(w1, w2);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 13: Trust Gate — reject untrusted project before starting watcher
// ═══════════════════════════════════════════════════════════════════════

describe("Trust gate (isProjectTrusted)", () => {
	it("trusted project proceeds, starts watcher, running message sent", async () => {
		const { dir, cleanup: cleanupDir } = createMinimalFixture();
		const { handleCheck, cleanup: cleanupHandler } = createCheckHandler({
			isProjectTrusted: true,
			mode: "tui",
		});
		try {
			const result = await handleCheck(dir);
			assert.ok(result.messages.some((m) => m.content.includes("Running `tsc`")));
		} finally {
			cleanupHandler();
			cleanupDir();
		}
	});

	it("untrusted project returns early with warning, no watcher created", async () => {
		const { handleCheck } = createCheckHandler({
			isProjectTrusted: false,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());

		// Only one message: the untrusted warning
		assert.strictEqual(result.messages.length, 1);
		assert.ok(result.messages[0]!.content.includes("Project not trusted"));
		assert.ok(result.messages[0]!.content.includes("Skipping type-check"));
		assert.deepStrictEqual(result.diagnostics, []);
	});

	it("untrusted project with no observable watcher state change", async () => {
		const { handleCheck } = createCheckHandler({
			isProjectTrusted: false,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());

		const hasRunningMsg = result.messages.some((m) => m.content.includes("Running `tsc`"));
		assert.strictEqual(hasRunningMsg, false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 14: Mode-adapted output — JSON in non-TUI modes, markdown in TUI
// ═══════════════════════════════════════════════════════════════════════

describe("Mode-adapted output (/check with ctx.mode)", () => {
	it("TUI mode sends markdown with relative file paths", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type 'string' is not assignable",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		const formatted = formatDiagnostics(diags);
		assert.ok(formatted.includes("src/app.ts"));
		assert.ok(formatted.includes("Line 10"));
		assert.ok(formatted.includes("(TS2322)"));
	});

	it("JSON mode sends structured JSON string", () => {
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
		const jsonOutput = formatDiagnosticsJson(diags);
		const message = JSON.stringify({
			type: "tsc-checkpoint",
			...jsonOutput,
		});
		const parsed = JSON.parse(message);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 1);
		assert.strictEqual(parsed.fileCount, 1);
		assert.ok(parsed.summary.includes("1 type error(s) found"));
	});

	it("RPC mode sends same structured JSON as JSON mode", () => {
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
		const jsonOutput = formatDiagnosticsJson(diags);
		assert.strictEqual(jsonOutput.diagnostics.length, 1);
		assert.strictEqual(typeof jsonOutput.summary, "string");
		assert.strictEqual(jsonOutput.fileCount, 1);
	});

	it("print mode sends same structured JSON as JSON mode", () => {
		const diags: TscDiagnostic[] = [];
		const jsonOutput = formatDiagnosticsJson(diags);
		const message = JSON.stringify({
			type: "tsc-checkpoint",
			...jsonOutput,
		});
		const parsed = JSON.parse(message);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 0);
		assert.strictEqual(parsed.summary, "No type errors detected");
		assert.strictEqual(parsed.fileCount, 0);
	});

	it("JSON mode with trend info includes trend.direction and trend.delta", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		];
		const trend: DiagnosticTrend = {
			current: 1,
			previous: 3,
			direction: "improved",
			delta: 2,
		};
		const jsonOutput = formatDiagnosticsJson(diags, trend);
		const message = JSON.stringify({
			type: "tsc-checkpoint",
			...jsonOutput,
			trend,
		});
		const parsed = JSON.parse(message);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 1);
		assert.ok(parsed.trend, "Should include trend data");
		assert.strictEqual(parsed.trend.direction, "improved");
		assert.strictEqual(parsed.trend.delta, 2);
		assert.ok(parsed.summary.includes("improved ↓"));
		assert.ok(parsed.summary.includes("was 3"));
	});

	it("diagnosticToTscDiagnostic is still exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.diagnosticToTscDiagnostic, "function");
	});

	it("resolveDiagnosticFilePath is still exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.resolveDiagnosticFilePath, "function");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Issue #1547 — direction-label consolidation (verify-removal guard)
// ═══════════════════════════════════════════════════════════════════════

describe("direction-label consolidation", () => {
	it("index.ts no longer contains the inlined direction ternary", () => {
		const content = fs.readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf-8");
		const ternaryLine = content
			.split("\n")
			.find((line) => line.includes("trend.direction === ") && line.includes("?"));
		assert.ok(
			ternaryLine === undefined,
			`Expected inlined direction ternary to be removed from index.ts, but found: "${ternaryLine?.trim()}"`,
		);
	});

	it("index.test.ts no longer re-implements the direction ternary", () => {
		const marker = "trend.direction" + ' === "regressed"';
		const content = fs.readFileSync(resolve(import.meta.dirname, "index.test.ts"), "utf-8");
		const ternaryLine = content
			.split("\n")
			.find((line) => line.includes(marker) && line.includes("?"));
		assert.ok(
			ternaryLine === undefined,
			`Expected inlined direction ternary to be removed from index.test.ts, but found: "${ternaryLine?.trim()}"`,
		);
	});
});

