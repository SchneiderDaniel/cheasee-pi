/**
 * tsc-checkpoint — Incremental type-checking with watch mode
 *
 * Wraps TypeScript's watch compiler API to provide incremental re-checks,
 * cached diagnostics, file-path resolution, and diagnostic trending.
 * Trigger manually with /check.
 *
 * This is the extension entry point and backward-compatible re-export hub.
 * All public API surface from sub-modules is re-exported for external consumers:
 *   supervisor/checks/audit-gate-decision.ts  (dynamic import via getRunGate)
 *   supervisor/test/pipeline-audit.test.mts  (static import)
 */

// ── Module Imports ─────────────────────────────────────────────────
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	TscDiagnostic,
	DiagnosticTrend,
} from "./types.ts";
import {
	diagnosticToTscDiagnostic,
	resolveDiagnosticFilePath,
} from "./adapter.ts";
import { DiagnosticsWatcher } from "./watcher.ts";
import { formatDiagnostics, formatDiagnosticsJson, directionLabel } from "./format.ts";
import { runTscCheckpoint } from "./checkpoint.ts";

// ═══════════════════════════════════════════════════════════════════════
// Backward-Compatible Re-exports
// ═══════════════════════════════════════════════════════════════════════

// Type re-exports
export type {
	TscDiagnostic,
	DiagnosticTrend,
} from "./types.ts";

// Value re-exports
export {
	diagnosticToTscDiagnostic,
	resolveDiagnosticFilePath,
} from "./adapter.ts";
export { DiagnosticsWatcher } from "./watcher.ts";
export { formatDiagnostics, formatDiagnosticsJson, directionLabel } from "./format.ts";
export { runTscCheckpoint } from "./checkpoint.ts";

// ═══════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register /check command for incremental tsc type-check.
 *
 * The first /check call spawns a TypeScript watch compiler that
 * incrementally re-checks on file changes. Subsequent /check calls
 * return the cached diagnostics from the last compilation.
 */
export default function tscCheckpoint(pi: ExtensionAPI): void {
	let watcher: DiagnosticsWatcher | null = null;

	// Clean up watcher when the session ends to prevent file watcher leaks
	pi.on?.("session_shutdown", () => {
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
	});

	pi.registerCommand?.("check", {
		description: "Run tsc --noEmit type-check on the current worktree (incremental watch mode)",
		handler: async (_args, ctx) => {
			const worktreePath = ctx.cwd;
			const tsconfigPath = resolve(worktreePath, "tsconfig.json");

			if (!existsSync(tsconfigPath)) {
				pi.sendUserMessage?.(
					"## TSC Checkpoint\n\nNo `tsconfig.json` found in worktree root. Skipping type-check.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			// ── Trust Gate ──────────────────────────────────────────────
			// Guard against unsafe project-local tsconfig before starting
			// the watch compiler. Use optional chaining for backward compat
			// with older pi-coding-agent versions where isProjectTrusted may
			// not be present in the type definitions.
			const isTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.();
			if (isTrusted === false) {
				pi.sendUserMessage?.(
					"## TSC Checkpoint — Project not trusted\n\nProject not trusted. Skipping type-check to avoid running `tsc` against potentially unsafe project-local configurations.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			// Create watcher lazily on first /check, or recreate when worktree changes
			if (!watcher || watcher.tsconfigPathValue !== tsconfigPath) {
				watcher?.stop(); // stop old watcher before creating a new one for a different worktree
				watcher = new DiagnosticsWatcher(tsconfigPath);
			}

			if (!watcher.isRunning()) {
				try {
					watcher.start();
					pi.sendUserMessage?.("## TSC Checkpoint\n\nRunning `tsc` in incremental watch mode...", {
						deliverAs: "followUp",
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					pi.sendUserMessage?.(`## TSC Checkpoint — Error\n\nFailed to start watcher: ${msg}`, {
						deliverAs: "followUp",
					});
					return;
				}
			}

			const diagnostics = watcher.getDiagnostics();
			const trend = watcher.getTrend();

			// ── Mode-Adapted Output ─────────────────────────────────────
			// TUI mode: markdown with clickable file paths.
			// JSON/RPC/Print mode: structured JSON for programmatic consumers.
			if (ctx.mode === "tui") {
				if (diagnostics.length > 0) {
					const formatted = formatDiagnostics(diagnostics);
					const errorCount = diagnostics.length;
					let msg = `## TSC Checkpoint — ${errorCount} Type Error(s) Found`;
					if (trend) {
						msg += ` (${directionLabel(trend.direction, "tui")})`;
					}
					msg += `\n\n${formatted}`;
					pi.sendUserMessage?.(msg, { deliverAs: "followUp" });
				} else {
					let msg = "## TSC Checkpoint — ✓ No type errors detected";
					if (trend && trend.current === 0 && trend.previous > 0) {
						msg += " (✓ all errors resolved)";
					}
					pi.sendUserMessage?.(msg, { deliverAs: "followUp" });
				}
			} else {
				// JSON/RPC/Print mode: structured JSON
				const jsonOutput = formatDiagnosticsJson(diagnostics, trend ?? undefined);
				const message = JSON.stringify({
					type: "tsc-checkpoint",
					...jsonOutput,
					...(trend ? { trend } : {}),
				});
				pi.sendUserMessage?.(message, { deliverAs: "followUp" });
			}
		},
	});
}
