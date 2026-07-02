/**
 * lsp-auditor — Pre-audit code quality via LSP before commit
 *
 * Runs language server checks on changed files. Reports diagnostics
 * as an audit step before code is committed or merged.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { runPreAudit } from "./run-pre-audit.ts";
import { readSettings } from "./settings.ts";
import { formatForMode } from "./output-adapter.ts";

/**
 * LSP Auditor extension entry point.
 *
 * The extension is passive — it's called by supervisor directly via runPreAudit().
 * No lifecycle hooks needed at this time.
 * Registers a command for manual triggering with mode-adapted output.
 */
export default function lspAuditor(pi: ExtensionAPI): void {
	pi.registerCommand?.("lsp-auditor", {
		description: "Run LSP diagnostics on modified files (manual trigger)",
		handler: async (_args, ctx) => {
			const sm = ctx.sessionManager;
			const cwd = sm.getCwd();

			// Parse args for future subcommand support (e.g., /lsp-auditor --files src/)
			const parsedArgs = parseArgs(_args.split(/\s+/));

			// Read defaultBranch from supervisor config if available
			let defaultBranch = "main";
			try {
				const settings = readSettings(cwd);
				if (settings?.supervisor && typeof settings.supervisor === "object") {
					const supCfg = settings.supervisor as Record<string, unknown>;
					if (typeof supCfg.defaultBranch === "string") {
						defaultBranch = supCfg.defaultBranch;
					}
				}
			} catch {
				/* use default */
			}

			const result = await runPreAudit(
				{ issueNum: 0, worktreePath: cwd, defaultBranch, repo: "" },
				pi,
				ctx,
			);

			// Adapt output per ctx.mode
			const mode = ctx.mode ?? "print";
			const hasUI = ctx.hasUI ?? false;

			if (mode === "tui" && hasUI) {
				// TUI mode: show notification via ctx.ui.notify, then send clickable results
				ctx.ui?.notify?.(result.note, result.proceed ? "info" : "warning");
				pi.sendMessage?.({
					content: `## LSP Audit Result\n\n${result.note}`,
					display: true,
					customType: "lsp-auditor",
				});
			} else if (mode === "rpc" || mode === "json") {
				// RPC/JSON mode: structured data that programmatic consumers can parse
				const diagnostics = extractLastDiagnostics(result);
				const structured =
					diagnostics.length > 0 ? formatForMode(diagnostics, mode, cwd, hasUI) : null;
				pi.sendMessage?.({
					content: JSON.stringify({
						proceed: result.proceed,
						note: result.note,
						diagnostics: structured,
					}),
					display: true,
					customType: "lsp-auditor",
				});
			} else {
				// Print/jetbrain mode: plain text
				pi.sendMessage?.({
					content: `LSP Audit result: ${result.note}`,
					display: true,
					customType: "lsp-auditor",
				});
			}
		},
	});
}

/**
 * Try to extract diagnostics from the last session turn for structured output.
 * In the command handler, the result only has note/proceed — diagnostics are
 * sent via sendUserMessage during runPreAudit. This helper reads the last
 * session entry to find diagnostics if available.
 *
 * For the structured RPC/JSON modes, we aim to provide the full diagnostic
 * payload. If unavailable in session, returns empty array.
 */
function extractLastDiagnostics(result: {
	proceed: boolean;
	note: string;
}): import("./types.ts").LspDiagnostic[] {
	// The runPreAudit sends diagnostics via sendUserMessage follow-ups.
	// For structured output modes, the command handler can't easily
	// re-extract them from the result object without parsing messages.
	// Return empty — extensions can override by storing diagnostics
	// in a module-level variable if needed.
	return [];
}


