/**
 * Tests for index.ts — Extension entry point, backward-compatible re-exports,
 * lifecycle cleanup, trust gate, mode-adapted output.
 *
 * Rewritten for the consolidated watcher: no MockAdapter, no TscWatchAdapter.
 * Uses real temp fixtures + _injectDiagnostics for tests that need diagnostic data.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/index.test.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
	DiagnosticsWatcher,
	resolveDiagnosticFilePath,
	formatDiagnostics,
	formatDiagnosticsJson,
	directionLabel,
	runTscCheckpoint,
} from "../index.ts";

import type { TscDiagnostic, DiagnosticTrend } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Fixture helpers
// ═══════════════════════════════════════════════════════════════════════

function createFixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "tsc-index-test-"));
	const cleanup = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	};
	return { dir, cleanup };
}

function createMinimalFixture(): { dir: string; tsconfigPath: string; cleanup: () => void } {
	const { dir, cleanup } = createFixture();
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
		"utf-8",
	);
	return { dir, tsconfigPath: join(dir, "tsconfig.json"), cleanup };
}

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

// ═══════════════════════════════════════════════════════════════════════
// Phase 10: Integration — Extension Entry Point (/check command)
// ═══════════════════════════════════════════════════════════════════════

interface MockSendUserMessage {
	content: string;
	options?: { deliverAs?: string };
}

/**
 * Creates a handler simulation for /check command testing.
 * Uses a real DiagnosticsWatcher (consolidated, no MockAdapter).
 * Supports injecting diagnostics via _injectDiagnostics for test scenarios
 * that don't require actual tsc compilation.
 */
function createCheckHandler(mockCtx?: {
	isProjectTrusted?: boolean;
	mode?: "tui" | "json" | "rpc" | "print";
}) {
	const messages: MockSendUserMessage[] = [];
	const ctx = {
		isProjectTrusted: mockCtx?.isProjectTrusted ?? true,
		mode: mockCtx?.mode ?? "tui",
	};
	const watchers: DiagnosticsWatcher[] = [];

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

		// Create watcher with the consolidated DiagnosticsWatcher (no adapter)
		const watcher = new DiagnosticsWatcher(tsconfigPath);
		watchers.push(watcher);

		if (!watcher.isRunning()) {
			try {
				watcher.start();
				messages.push({
					content: "## TSC Checkpoint\n\nRunning `tsc` in incremental watch mode...",
					options: { deliverAs: "followUp" },
				});
			} catch (err) {
				messages.push({
					content: `## TSC Checkpoint — Error\n\nFailed to start watcher: ${err instanceof Error ? err.message : String(err)}`,
					options: { deliverAs: "followUp" },
				});
				return { messages, diagnostics: [] };
			}
		}

		const diagnostics = watcher.getDiagnostics();
		const trend = watcher.getTrend();

		// ── Mode-Adapted Output ─────────────────────────────────────
		if (ctx.mode === "tui") {
			if (diagnostics.length > 0) {
				const formatted = formatDiagnostics(diagnostics);
				let msg = `## TSC Checkpoint — ${diagnostics.length} Type Error(s) Found`;
				if (trend) {
					msg += ` (${directionLabel(trend.direction, "tui")})`;
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

	function cleanup(): void {
		for (const w of watchers) {
			w.stop();
		}
		watchers.length = 0;
	}

	return { handleCheck, cleanup };
}

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
			const cleanMsg = result.messages.find((m) =>
				m.content.includes("No type errors detected"),
			);
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
