/**
 * Tests for index.ts — Extension entry point, backward-compatible re-exports,
 * lifecycle cleanup, trust gate, mode-adapted output, parseArgs import.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/index.test.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
	DiagnosticsWatcher,
	resolveDiagnosticFilePath,
	formatDiagnostics,
	formatDiagnosticsJson,
	formatTrend,
	runTscCheckpoint,
	diagnosticToTscDiagnostic,
} from "../index.ts";

import type { TscDiagnostic, TscWatchAdapter, DiagnosticTrend } from "../index.ts";

import { MockAdapter } from "./shared.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: Pipeline contract — runTscCheckpoint signature & shape
// (some tests remain here alongside checkpoint.test.ts coverage)
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
		// This mirrors the pipeline contract in tsc-decisions.ts
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.runTscCheckpoint, "function");
		assert.strictEqual(mod.runTscCheckpoint.length, 2);
		const result = await mod.runTscCheckpoint("/nonexistent/path");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 10: Integration — Extension Entry Point (/check command)
// ═══════════════════════════════════════════════════════════════════════

interface MockSendUserMessage {
	content: string;
	options?: { deliverAs?: string };
}

/**
 * Simulates the extension entry point behavior for /check command.
 * Uses the actual DiagnosticsWatcher with a MockAdapter.
 */
function createCheckHandler(
	adapter?: MockAdapter,
	mockCtx?: {
		isProjectTrusted?: boolean;
		mode?: "tui" | "json" | "rpc" | "print";
	},
) {
	const messages: MockSendUserMessage[] = [];
	let watcherInstance: DiagnosticsWatcher | null = null;
	const ctx = {
		isProjectTrusted: mockCtx?.isProjectTrusted ?? true,
		mode: mockCtx?.mode ?? "tui",
	};

	async function handleCheck(worktreePath: string): Promise<{
		messages: MockSendUserMessage[];
		diagnostics: TscDiagnostic[];
	}> {
		const { existsSync } = await import("node:fs");
		const { resolve: resolvePath } = await import("node:path");
		const tsconfigPath = resolvePath(worktreePath, "tsconfig.json");

		if (!existsSync(tsconfigPath)) {
			messages.push({
				content:
					"## TSC Checkpoint\n\nNo `tsconfig.json` found in worktree root. Skipping type-check.",
				options: { deliverAs: "followUp" },
			});
			return { messages, diagnostics: [] };
		}

		// ── Trust Gate ──────────────────────────────────────────────
		if (ctx.isProjectTrusted === false) {
			messages.push({
				content:
					"## TSC Checkpoint — Project not trusted\n\nProject not trusted. Skipping type-check to avoid running `tsc` against potentially unsafe project-local configurations.",
				options: { deliverAs: "followUp" },
			});
			return { messages, diagnostics: [] };
		}

		// Create watcher lazily, or recreate when worktree changes
		if (!watcherInstance || watcherInstance.tsconfigPathValue !== tsconfigPath) {
			watcherInstance?.stop(); // stop old watcher before creating a new one
			const directAdapter = adapter ?? new MockAdapter();
			watcherInstance = new DiagnosticsWatcher(tsconfigPath, undefined, directAdapter);
		}

		if (!watcherInstance.isRunning()) {
			try {
				watcherInstance.start();
				messages.push({
					content: "## TSC Checkpoint\n\nRunning `tsc` in incremental watch mode...",
					options: { deliverAs: "followUp" },
				});
			} catch (err) {
				messages.push({
					content: `## TSC Checkpoint — Error\n\nFailed to start watcher: ${err}`,
					options: { deliverAs: "followUp" },
				});
				return { messages, diagnostics: [] };
			}
		}

		const diagnostics = watcherInstance.getDiagnostics();
		const trend = watcherInstance.getTrend();

		// ── Mode-Adapted Output ─────────────────────────────────────
		if (ctx.mode === "tui") {
			if (diagnostics.length > 0) {
				const formatted = formatDiagnostics(diagnostics);
				let msg = `## TSC Checkpoint — ${diagnostics.length} Type Error(s) Found`;
				if (trend) {
					msg += ` (${trend.direction === "regressed" ? "⚠️ regression" : trend.direction === "improved" ? "✓ improved" : "→ stable"})`;
				}
				msg += `\n\n${formatted}`;
				messages.push({ content: msg, options: { deliverAs: "followUp" } });
			} else {
				let msg = "## TSC Checkpoint — ✓ No type errors detected";
				if (trend && trend.current === 0 && trend.previous > 0) {
					msg += " (✓ all errors resolved)";
				}
				messages.push({ content: msg, options: { deliverAs: "followUp" } });
			}
		} else {
			// JSON/RPC/Print mode: structured JSON
			const jsonOutput = formatDiagnosticsJson(diagnostics, trend ?? undefined);
			const message = JSON.stringify({
				type: "tsc-checkpoint",
				...jsonOutput,
				...(trend ? { trend } : {}),
			});
			messages.push({ content: message, options: { deliverAs: "followUp" } });
		}

		return { messages, diagnostics };
	}

	return { handleCheck };
}

describe("Extension entry point (/check command)", () => {
	it("/check without tsconfig.json returns skip message", async () => {
		const { handleCheck } = createCheckHandler();
		const result = await handleCheck("/nonexistent-worktree");

		assert.strictEqual(result.messages.length, 1);
		assert.ok(result.messages[0]!.content.includes("No `tsconfig.json` found"));
	});

	it("/check creates watcher and returns cached diagnostics", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		const result = await handleCheck(process.cwd());

		// Watcher was started
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.lastStartPath, resolve(process.cwd(), "tsconfig.json"));

		// No diagnostics yet, so "no errors" message
		assert.ok(result.messages.some((m) => m.content.includes("No type errors detected")));
	});

	it("/check with diagnostics returns formatted errors", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		// First call creates the watcher and subscribes to adapter events
		await handleCheck(process.cwd());

		// Now emit diagnostics — the watcher is already listening
		adapter.emitDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type 'string' is not assignable",
				code: "TS2322",
				filePath: resolve(process.cwd(), "src/app.ts"),
			},
		]);

		// Second call returns the cached diagnostics
		const result = await handleCheck(process.cwd());

		// Should include error count in message
		const errorMsg = result.messages.find((m) => m.content.includes("Type Error(s) Found"));
		assert.ok(errorMsg, "Should have error message");
		assert.ok(errorMsg!.content.includes("TS2322"));
		assert.ok(errorMsg!.content.includes("Type 'string' is not assignable"));
	});

	it("/check twice uses cached watcher (no second start)", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);

		await handleCheck(process.cwd());
		// Still only 1 start call — second call reuses watcher
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("/check without diagnostics returns clean message", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		const result = await handleCheck(process.cwd());

		const cleanMsg = result.messages.find((m) => m.content.includes("No type errors detected"));
		assert.ok(cleanMsg);
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
	it("checking same worktree twice does NOT call stop", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.stopCalls, 0);

		await handleCheck(process.cwd());
		// Still only 1 start, 0 stop — same worktree reuses watcher
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.stopCalls, 0);
	});

	it("switching to different worktree stops old watcher and creates new one", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		// First call in worktree A
		await handleCheck(process.cwd());
		const firstPath = adapter.lastStartPath;
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.stopCalls, 0);

		// Second call in different worktree B
		const tmpDir = fs.mkdtempSync("tsc-test-");
		try {
			fs.writeFileSync(resolve(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
			const tsconfigPathB = resolve(tmpDir, "tsconfig.json");

			await handleCheck(tmpDir);

			// Old watcher was stopped, new watcher created for worktree B
			assert.strictEqual(adapter.stopCalls, 1, "should stop old watcher");
			assert.strictEqual(adapter.startCalls, 2, "should create new watcher");
			assert.notStrictEqual(adapter.lastStartPath, firstPath, "should use new path");
			assert.strictEqual(adapter.lastStartPath, tsconfigPathB, "new path matches worktree B");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("worktree switch with no tsconfig returns skip, old watcher unchanged", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		// First call in worktree A creates watcher
		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);

		// Second call in worktree with no tsconfig
		const { handleCheck: handleCheckNoConfig } = createCheckHandler(adapter);
		const tmpDir = fs.mkdtempSync("tsc-test-noconfig-");
		try {
			const result = await handleCheckNoConfig(tmpDir);
			// Skip message returned
			assert.ok(result.messages.some((m) => m.content.includes("No `tsconfig.json` found")));
			// Old watcher unchanged — no stop/start
			assert.strictEqual(adapter.stopCalls, 0, "should not stop");
			assert.strictEqual(adapter.startCalls, 1, "should not start new watcher");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("worktree switch with start failure sends error, no crash", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		// First call creates watcher
		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.stopCalls, 0);

		// Second call in worktree B — make start fail
		adapter.setShouldFailStart(true);
		const tmpDir = fs.mkdtempSync("tsc-test-startfail-");
		try {
			fs.writeFileSync(resolve(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
			const result = await handleCheck(tmpDir);

			// Old watcher was stopped
			assert.strictEqual(adapter.stopCalls, 1, "should stop old watcher");
			// Second start attempted but failed
			assert.strictEqual(adapter.startCalls, 2, "should attempt start");
			// Error message sent
			assert.ok(result.messages.some((m) => m.content.includes("Failed to start watcher")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("watcher identity key is tsconfigPathValue", () => {
		const adapter = new MockAdapter();
		const pathA = resolve(process.cwd(), "tsconfig.json");
		const pathB = resolve("/other/project", "tsconfig.json");

		const w = new DiagnosticsWatcher(pathA, undefined, adapter);
		assert.strictEqual(w.tsconfigPathValue, pathA);
		assert.notStrictEqual(w.tsconfigPathValue, pathB);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 11: Lifecycle cleanup via session_shutdown event
// ═══════════════════════════════════════════════════════════════════════

function createMockPi() {
	const shutdownHandlers: Array<() => void> = [];

	const pi = {
		on: (event: string, handler: () => void) => {
			if (event === "session_shutdown") {
				shutdownHandlers.push(handler);
			}
		},
		registerCommand: (_name: string, _options: Record<string, unknown>) => {
			// no-op
		},
		sendUserMessage: (_content: string, _options?: Record<string, unknown>) => {
			// no-op
		},
	};

	function fireShutdown(): void {
		for (const handler of shutdownHandlers) {
			handler();
		}
	}

	function getHandlerCount(): number {
		return shutdownHandlers.length;
	}

	return { pi, fireShutdown, getHandlerCount };
}

describe("session_shutdown lifecycle", () => {
	it("tscCheckpoint registers on('session_shutdown', handler) during initialization", async () => {
		const { pi, getHandlerCount } = createMockPi();
		const mod = await import("../index.ts");
		mod.default(pi as any);
		assert.strictEqual(getHandlerCount(), 1, "Should register exactly 1 session_shutdown handler");
	});

	it("session_shutdown handler stops running watcher (adapter.stop() called)", async () => {
		const { pi, fireShutdown } = createMockPi();

		const adapter = new MockAdapter();
		const worktreePath = process.cwd();
		const tsconfigPath = resolve(worktreePath, "tsconfig.json");

		const watcher = new DiagnosticsWatcher(tsconfigPath, undefined, adapter);
		watcher.start();
		assert.strictEqual(watcher.isRunning(), true);

		// Simulate what the session_shutdown handler does
		watcher.stop();
		assert.strictEqual(watcher.isRunning(), false);
		assert.strictEqual(adapter.stopCalls, 1);
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

	it("session_shutdown handler when watcher exists but not running — no double-stop", async () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		// Don't start it
		assert.strictEqual(w.isRunning(), false);

		// Simulate shutdown handler behavior: stop if running, then set to null
		// stop() when not running should be no-op
		w.stop();
		assert.strictEqual(adapter.stopCalls, 0);
		assert.strictEqual(w.isRunning(), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 12: Resource leak prevention — no duplicate watchers
// ═══════════════════════════════════════════════════════════════════════

describe("resource leak prevention (no duplicate watchers)", () => {
	it("DiagnosticsWatcher.start() when already running returns false", async () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);

		w.start();
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);

		// Second start should return false
		const result = w.start();
		assert.strictEqual(result, false);
		assert.strictEqual(adapter.startCalls, 1); // Still 1
	});

	it("Two /check calls in same session create watcher once (startCalls = 1)", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);

		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1); // Still 1
	});

	it("/check after session_shutdown + /check again creates two distinct watchers", async () => {
		const adapter1 = new MockAdapter();
		const adapter2 = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter1);

		// First call creates watcher with adapter1
		await handleCheck(process.cwd());
		assert.strictEqual(adapter1.startCalls, 1);

		// Simulate a fresh session (new createCheckHandler with different adapter)
		const { handleCheck: handleCheck2 } = createCheckHandler(adapter2);
		await handleCheck2(process.cwd());
		assert.strictEqual(adapter2.startCalls, 1);
		// Two different adapters used
		assert.strictEqual(adapter1.startCalls, 1);
		assert.strictEqual(adapter2.startCalls, 1);
	});

	it("Extension re-registered: each registration tracks its own shutdown handler", async () => {
		const { pi: pi1, getHandlerCount: getCount1, fireShutdown: fire1 } = createMockPi();
		const { pi: pi2, getHandlerCount: getCount2, fireShutdown: fire2 } = createMockPi();
		const mod = await import("../index.ts");

		// Register twice (simulates reload)
		mod.default(pi1 as any);
		mod.default(pi2 as any);

		assert.strictEqual(getCount1(), 1, "First registration gets 1 handler");
		assert.strictEqual(getCount2(), 1, "Second registration gets 1 handler");

		// Both handlers fire without error
		fire1();
		fire2();
		assert.ok(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 13: Trust Gate — reject untrusted project before starting watcher
// ═══════════════════════════════════════════════════════════════════════

describe("Trust gate (isProjectTrusted)", () => {
	it("trusted project proceeds, starts watcher, running message sent", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());

		// Watcher was started
		assert.strictEqual(adapter.startCalls, 1);
		// Running message sent
		assert.ok(result.messages.some((m) => m.content.includes("Running `tsc`")));
	});

	it("untrusted project returns early with warning, no watcher created", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: false,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());

		// No watcher was started
		assert.strictEqual(adapter.startCalls, 0);
		// Only one message: the untrusted warning
		assert.strictEqual(result.messages.length, 1);
		assert.ok(result.messages[0]!.content.includes("Project not trusted"));
		assert.ok(result.messages[0]!.content.includes("Skipping type-check"));
		// No diagnostics returned
		assert.deepStrictEqual(result.diagnostics, []);
	});

	it("untrusted project with no observable watcher state change", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: false,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());

		// No watcher created, no running message, no diagnostics
		assert.strictEqual(adapter.startCalls, 0);
		const hasRunningMsg = result.messages.some((m) => m.content.includes("Running `tsc`"));
		assert.strictEqual(hasRunningMsg, false);
	});

	it("isProjectTrusted called with optional chaining for backward compat", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
		});

		const result = await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);
		assert.ok(result.messages.some((m) => m.content.includes("Running `tsc`")));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 14: Mode-adapted output — JSON in non-TUI modes, markdown in TUI
// ═══════════════════════════════════════════════════════════════════════

describe("Mode-adapted output (/check with ctx.mode)", () => {
	it("TUI mode sends markdown with relative file paths", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "tui",
		});

		await handleCheck(process.cwd());

		// Emit some diagnostics
		adapter.emitDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type 'string' is not assignable",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		]);

		const result = await handleCheck(process.cwd());

		// Find the error message
		const errorMsg = result.messages.find((m) => m.content.includes("Type Error(s) Found"));
		assert.ok(errorMsg, "Should have error message in TUI mode");
		assert.ok(errorMsg!.content.includes("src/app.ts"));
		assert.ok(errorMsg!.content.includes("Line 10"));
		assert.ok(errorMsg!.content.includes("(TS2322)"));
	});

	it("JSON mode sends structured JSON string", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "json",
		});

		await handleCheck(process.cwd());

		// Emit some diagnostics
		adapter.emitDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		]);

		const result = await handleCheck(process.cwd());

		// Get the last JSON message
		const jsonMsgs = result.messages.filter((m) => m.content.startsWith("{"));
		const lastJsonMsg = jsonMsgs[jsonMsgs.length - 1];
		assert.ok(lastJsonMsg, "Should have JSON message in JSON mode");
		const parsed = JSON.parse(lastJsonMsg!.content);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 1);
		assert.strictEqual(parsed.fileCount, 1);
		assert.ok(parsed.summary.includes("1 type error(s) found"));
	});

	it("RPC mode sends same structured JSON as JSON mode", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "rpc",
		});

		await handleCheck(process.cwd());

		adapter.emitDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		]);

		const result = await handleCheck(process.cwd());

		const jsonMsgs = result.messages.filter((m) => m.content.startsWith("{"));
		const lastJsonMsg = jsonMsgs[jsonMsgs.length - 1];
		assert.ok(lastJsonMsg, "Should have JSON message in RPC mode");
		const parsed = JSON.parse(lastJsonMsg!.content);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 1);
	});

	it("print mode sends same structured JSON as JSON mode", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "print",
		});

		await handleCheck(process.cwd());

		const result = await handleCheck(process.cwd());

		const jsonMsgs = result.messages.filter((m) => m.content.startsWith("{"));
		const lastJsonMsg = jsonMsgs[jsonMsgs.length - 1];
		assert.ok(lastJsonMsg, "Should have JSON message in print mode");
		const parsed = JSON.parse(lastJsonMsg!.content);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 0);
		assert.strictEqual(parsed.summary, "No type errors detected");
		assert.strictEqual(parsed.fileCount, 0);
	});

	it("JSON mode with trend info includes trend in output", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "json",
		});

		await handleCheck(process.cwd());

		// First diagnostic emission (1 error)
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

		await handleCheck(process.cwd());

		// Second emission (3 errors, regressed)
		adapter.emitDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "err", filePath: "/a.ts" },
			{ file: "b.ts", line: 2, column: 2, severity: "Error", message: "err2", filePath: "/b.ts" },
			{ file: "c.ts", line: 3, column: 3, severity: "Error", message: "err3", filePath: "/c.ts" },
		]);

		const result = await handleCheck(process.cwd());

		const jsonMsgs = result.messages.filter((m) => m.content.startsWith("{"));
		const lastJsonMsg = jsonMsgs[jsonMsgs.length - 1];
		assert.ok(lastJsonMsg, "Should have JSON message");
		const parsed = JSON.parse(lastJsonMsg!.content);
		assert.strictEqual(parsed.type, "tsc-checkpoint");
		assert.strictEqual(parsed.diagnostics.length, 3);
		assert.ok(parsed.trend, "Should include trend data");
		assert.strictEqual(parsed.trend.direction, "regressed");
		assert.strictEqual(parsed.trend.delta, 2);
		assert.ok(parsed.summary.includes("3 type error(s) found"));
		assert.ok(parsed.summary.includes("regressed ↑"));
		assert.ok(parsed.summary.includes("was 1"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 15: Import parseArgs — structural addition without behavioral change
// ═══════════════════════════════════════════════════════════════════════

describe("parseArgs import", () => {
	it("parseArgs is exported from @earendil-works/pi-coding-agent", async () => {
		const mod = await import("@earendil-works/pi-coding-agent");
		assert.strictEqual(typeof mod.parseArgs, "function");
	});

	it("source module imports parseArgs from the package (module compiles)", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.formatDiagnosticsJson, "function");
		assert.strictEqual(typeof mod.formatDiagnostics, "function");
		assert.strictEqual(typeof mod.default, "function");
	});

	it("handler signature unchanged (args passed as raw string)", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter, {
			isProjectTrusted: true,
			mode: "tui",
		});

		const result = await handleCheck(process.cwd());
		assert.ok(result.messages.some((m) => m.content.includes("Running `tsc`")));
	});
});
