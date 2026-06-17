/**
 * format-on-save — Auto-formats TS/JS files and reports lint diagnostics.
 *
 * Orchestrator layer: injects Formatter + Linter adapters, handles path
 * validation, size checks, trust gate, and mode-adaptive notifications.
 * Pure execution logic is delegated to adapters — no prettier/eslint imports.
 *
 * Triggers on every `write`/`edit` tool result. Non-blocking advisory only.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { looksLikeFilePath, MAX_FILE_SIZE_BYTES } from "./formatting.mts";
import { formatEslintDiagnostics } from "./eslint.mts";
import type { Formatter, Linter } from "./ports.mts";

// ─── Handler Registration ────────────────────────────────────────────

/**
 * Register the tool_result handler with injected adapters.
 *
 * Exported separately for testability: tests pass mock Formatter/Linter
 * instances to verify orchestration behavior without real backends.
 *
 * @param pi        ExtensionAPI instance
 * @param formatter Formatter adapter (e.g. PrettierFormatter)
 * @param linter    Linter adapter (e.g. EslintLinter)
 */
export function registerHandler(pi: ExtensionAPI, formatter: Formatter, linter: Linter): void {
	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		try {
			// Only handle write and edit tools
			if (event.toolName !== "write" && event.toolName !== "edit") return;

			// Skip errors
			if (event.isError) return;

			// Extract the file path from input
			const filePath = (event.input as { path?: string }).path;
			if (!looksLikeFilePath(filePath)) return;

			// Resolve relative paths against cwd
			const absolutePath = resolve(ctx.cwd, filePath);

			// Skip files that don't exist
			if (!existsSync(absolutePath)) return;

			// Skip files that are too large
			try {
				const stats = statSync(absolutePath);
				if (stats.size > MAX_FILE_SIZE_BYTES) return;
			} catch {
				return;
			}

			// 🔒 Trust gate: skip formatting/linting on untrusted projects
			if (!ctx.isProjectTrusted()) return;

			// Step 1: Format
			if (formatter.canHandle(absolutePath)) {
				await handleFormat(pi, ctx, filePath, formatter, absolutePath);
			}

			// Step 2: Lint
			if (linter.canHandle(absolutePath)) {
				await handleLint(pi, ctx, filePath, linter, absolutePath);
			}
		} catch (err) {
			console.error("format-on-save: error in tool_result handler:", err);
		}
	});
}

// ─── Format Handling ──────────────────────────────────────────────────

async function handleFormat(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	filePath: string,
	formatter: Formatter,
	absolutePath: string,
): Promise<void> {
	let formatResult;
	try {
		formatResult = await formatter.format(absolutePath);
	} catch (err) {
		console.error(`format-on-save: formatter threw for ${filePath}:`, err);
		return;
	}

	if (formatResult.error) {
		// Format error — notify user
		console.error(`format-on-save: format error for ${filePath}: ${formatResult.error}`);
		if (ctx.mode === "tui") {
			ctx.ui.notify(`Format failed: ${filePath}`, "error");
		} else if (ctx.mode === "rpc") {
			pi.sendUserMessage(`Format failed: ${filePath}`, {
				deliverAs: "followUp",
			});
		}
		// JSON/print: just console.error
		return;
	}

	if (formatResult.formatted) {
		// Format success notification — mode-adaptive
		if (ctx.mode === "tui") {
			ctx.ui.notify(`Formatted: ${filePath}`, "info");
		} else if (ctx.mode === "rpc") {
			pi.sendUserMessage(`Formatted: ${filePath}`, {
				deliverAs: "followUp",
			});
		}
		// JSON/print: no notification for format
	}
	// formatResult.formatted === false (no change): silent
}

// ─── Lint Handling ────────────────────────────────────────────────────

/**
 * Check if an error message indicates an ESLint configuration error.
 * Used to add [config error] prefix when logging lint errors.
 * Mirrors the keyword patterns from EslintLinter.isConfigError().
 */
function isConfigErrorMessage(message: string): boolean {
	return (
		message.includes("ConfigError") ||
		message.includes("Failed to load") ||
		message.includes("Could not find") ||
		message.includes("eslint.config") ||
		message.includes(".eslintrc") ||
		message.includes("configuration") ||
		message.includes("Config (")
	);
}

async function handleLint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	filePath: string,
	linter: Linter,
	absolutePath: string,
): Promise<void> {
	let lintResult;
	try {
		lintResult = await linter.lint(absolutePath);
	} catch (err) {
		console.error(`format-on-save: linter threw for ${filePath}:`, err);
		return;
	}

	if (lintResult.error) {
		// Lint error — log, don't crash, don't send followUp
		// Prefix [config error] when the error matches config error patterns
		const prefix = isConfigErrorMessage(lintResult.error) ? "[config error] " : "";
		console.error(`format-on-save: lint error for ${filePath}: ${prefix}${lintResult.error}`);
		return;
	}

	// Lint ran — TUI notification
	if (ctx.mode === "tui") {
		ctx.ui.notify(`Lint ran: ${filePath}`, "info");
	}

	// Send diagnostics followUp if non-empty
	if (lintResult.diagnostics.length > 0) {
		const diagnosticMsg = formatEslintDiagnostics(lintResult.diagnostics);
		const followUp = [
			`## Lint Diagnostics — ${filePath}`,
			``,
			`ESLint found the following issues (advisory — not blocking):`,
			``,
			diagnosticMsg,
		].join("\n");
		pi.sendUserMessage(followUp, { deliverAs: "followUp" });
	}
	// Empty diagnostics: no followUp
}

// ─── Extension Factory (default) ──────────────────────────────────────

/**
 * Default extension factory.
 * Creates real adapters (PrettierFormatter, EslintLinter) and registers
 * the handler. Called by the extension loader.
 *
 * Async to allow dynamic imports of adapter modules.
 * Adapters handle missing dependencies gracefully internally.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	const { PrettierFormatter } = await import("./prettier-adapter.mts");
	const { EslintLinter } = await import("./eslint-adapter.mts");

	// Use process.cwd() as project root for .prettierrc resolution.
	// This matches the legacy behavior where findProjectRoot walks up
	// from the working directory to find the project root.
	const projectRoot = process.cwd();
	const formatter: Formatter = new PrettierFormatter(projectRoot);
	const linter: Linter = new EslintLinter();

	registerHandler(pi, formatter, linter);
}
