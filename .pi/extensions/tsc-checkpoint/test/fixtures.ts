// ─── tsc-checkpoint test fixtures (issue #2005 Long File split) ───
// Shared fixture helpers moved out of index.test.ts. Non-test module so
// `node --test` does not load it as a suite.

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

export function createFixture(): { dir: string; cleanup: () => void } {
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

export function createMinimalFixture(): { dir: string; tsconfigPath: string; cleanup: () => void } {
	const { dir, cleanup } = createFixture();
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
		"utf-8",
	);
	return { dir, tsconfigPath: join(dir, "tsconfig.json"), cleanup };
}

export interface MockSendUserMessage {
	content: string;
	options?: { deliverAs?: string };
}

/**
 * Creates a handler simulation for /check command testing.
 * Uses a real DiagnosticsWatcher (consolidated, no MockAdapter).
 * Supports injecting diagnostics via _injectDiagnostics for test scenarios
 * that don't require actual tsc compilation.
 */
export function createCheckHandler(mockCtx?: {
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

export function createMockPi() {
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
