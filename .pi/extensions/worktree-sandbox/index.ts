/**
 * Worktree Sandbox Extension
 *
 * Enforces that developer/auditor agents operate ONLY within their assigned
 * git worktree. Intercepts tool calls and rewrites paths to target the
 * worktree instead of the main checkout.
 *
 * Deterministic enforcement — not prompt-level, not behavioral.
 * LLM cannot bypass because tool input mutation runs before execution.
 *
 * Activation: set WORKTREE_SANDBOX_PATH env var to the worktree root.
 * When unset, all handlers pass through (no-op mode).
 *
 * Sandbox rules:
 *   read/write/edit: relative paths -> prepend worktree root.
 *                     absolute paths -> block if outside worktree.
 *   bash:            prepend `cd worktree &&` to every command.
 *                     block/reject cd commands that escape worktree.
 *
 * This file is the public API barrel: it owns the sandbox path mechanics,
 * the extension factory, and re-exports the detector modules.
 * Import graph is a strict DAG:
 *   meaningful-token.ts ← { unsafe-cd.ts, unsafe-write.ts } ← index.ts
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { findUnsafeCd } from "./unsafe-cd.ts";
import { findUnsafeWriteInBash } from "./unsafe-write.ts";
import { isPathWithinSandbox } from "./meaningful-token.ts";

// ─── Constants ──────────────────────────────────────────────────────

const SANDBOX_ENV_KEY = "WORKTREE_SANDBOX_PATH";

// ─── Helpers ────────────────────────────────────────────────────────

function getSandboxRoot(): string | null {
	const root = process.env[SANDBOX_ENV_KEY];
	if (!root || !root.trim()) return null;
	const normalized = resolvePath(root.trim());
	if (!normalized) return null;
	if (!existsSync(normalized)) return null;
	if (!statSync(normalized).isDirectory()) return null;
	return normalized;
}

/**
 * Check if a `read` tool targets a directory path.
 * Returns a block result with guidance to use `bash ls` instead.
 * Non-existent paths (ENOENT) and permission-denied (EACCES) pass through
 * to pi-core's normal error handling.
 */
function checkReadIsDirectory(
	pathToCheck: string,
	toolName: "read" | "write" | "edit",
	originalPath: string,
): ToolCallEventResult | undefined {
	if (toolName !== "read") return undefined;
	try {
		if (statSync(pathToCheck).isDirectory()) {
			return {
				block: true,
				reason: `Path "${originalPath}" is a directory. Use \`bash ls ${originalPath}\` to list its contents.`,
			};
		}
	} catch {
		// ENOENT — path doesn't exist → pass through to pi-core's "not found" flow
		// EACCES — permission denied → pass through to pi-core's "permission denied" flow
	}
	return undefined;
}

/**
 * Shared path-rewriting logic for read/write/edit tool handlers.
 *
 * Previously duplicated across three handlers. Extracted to eliminate
 * near-miss clone maintenance burden.
 *
 * @param toolName - The tool name ("read", "write", or "edit")
 * @param event - The tool call event (mutated in place for relative paths)
 * @param sandboxRoot - The resolved worktree sandbox root
 * @param ctx - Extension context (for UI notifications)
 * @param blockNoun - Noun phrase for block reason ("file operations", "writes", "edits")
 * @returns Block result or undefined (pass-through)
 */
export function rewritePath(
	toolName: "read" | "write" | "edit",
	event: { input: { path: string } },
	sandboxRoot: string,
	ctx: {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
	},
	blockNoun: "file operations" | "writes" | "edits",
): ToolCallEventResult | undefined {
	const originalPath = event.input.path;
	if (!originalPath) return undefined;

	if (originalPath.startsWith("/")) {
		if (!isPathWithinSandbox(originalPath, sandboxRoot)) {
			if (ctx.hasUI) {
				const mode = (ctx as Record<string, unknown>).mode;
				const level = mode && mode !== "tui" ? "error" : "warning";
				ctx.ui.notify(`[sandbox] Blocked ${toolName} to outside worktree: ${originalPath}`, level);
			}
			return {
				block: true,
				reason: `Path "${originalPath}" is outside the worktree. All ${blockNoun} must stay within the worktree.`,
			};
		}
		const dirCheck = checkReadIsDirectory(originalPath, toolName, originalPath);
		if (dirCheck) return dirCheck;
		return undefined;
	}

	const rewritten = resolvePath(sandboxRoot, originalPath);
	if (!isPathWithinSandbox(rewritten, sandboxRoot)) {
		return { block: true, reason: `Path "${originalPath}" resolves outside the worktree.` };
	}
	const dirCheck = checkReadIsDirectory(rewritten, toolName, originalPath);
	if (dirCheck) return dirCheck;
	event.input.path = rewritten;
	return undefined;
}

// ─── Public API re-exports ──────────────────────────────────────────
// Detector concerns live in sibling modules (see file header for the
// import DAG). Re-exported here so all consumers import from index.ts.

export { tokenizeCommand, hasShellExpansion } from "./meaningful-token.ts";
export { SEPARATORS, isCommandStart, findMeaningfulToken } from "./meaningful-token.ts";
export type { MeaningfulTokenResult } from "./meaningful-token.ts";
export { findUnsafeCd } from "./unsafe-cd.ts";
export { findUnsafeWriteInBash } from "./unsafe-write.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// ── Mode gate ──────────────────────────────────────────────
		// Skip sandbox enforcement in print/JSON modes where no file
		// operations occur. Avoids existsSync()+statSync() overhead.
		const mode = (ctx as { mode?: string }).mode;
		const isFileMode = mode === "tui" || mode === "rpc" || !mode;
		if (!isFileMode) {
			return undefined;
		}

		// ── Trust gate ─────────────────────────────────────────────
		// Check project trust BEFORE resolving sandbox root, so that
		// an untrusted project cannot control WORKTREE_SANDBOX_PATH
		// and redirect sandbox operations to attacker-controlled paths.
		const isTrusted = (
			ctx as { isProjectTrusted?: () => boolean | undefined }
		).isProjectTrusted?.();
		if (isTrusted === false) {
			if (ctx.hasUI) {
				ctx.ui.notify("[sandbox] Project not trusted — skipping sandbox enforcement", "warning");
			}
			return undefined;
		}

		const sandboxRoot = getSandboxRoot();
		if (!sandboxRoot) {
			return undefined;
		}

		// ── read / write / edit tools ──────────────────────────────
		if (isToolCallEventType("read", event)) {
			return rewritePath("read", event, sandboxRoot, ctx, "file operations") ?? undefined;
		}

		if (isToolCallEventType("write", event)) {
			return rewritePath("write", event, sandboxRoot, ctx, "writes") ?? undefined;
		}

		if (isToolCallEventType("edit", event)) {
			return rewritePath("edit", event, sandboxRoot, ctx, "edits") ?? undefined;
		}

		// ── bash tool ──────────────────────────────────────────────
		if (isToolCallEventType("bash", event)) {
			const originalCommand = event.input.command as string;
			if (!originalCommand) return undefined;

			// Block cd commands that escape worktree
			const unsafeCd = findUnsafeCd(originalCommand, sandboxRoot);
			if (unsafeCd) {
				if (ctx.hasUI) {
					ctx.ui.notify(`[sandbox] Blocked cd to outside worktree: ${unsafeCd}`, "warning");
				}
				return {
					block: true,
					reason: `Command tries to cd to "${unsafeCd}" which is outside the worktree. Working directory cannot escape the worktree (${sandboxRoot}).`,
				};
			}

			// Block file writes via bash to absolute paths outside worktree
			const unsafeWrite = findUnsafeWriteInBash(originalCommand, sandboxRoot);
			if (unsafeWrite) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sandbox] Blocked bash write to outside worktree: ${unsafeWrite}`,
						"warning",
					);
				}
				return {
					block: true,
					reason: `Command writes to "${unsafeWrite}" which is outside the worktree. All file writes via bash must target paths within the worktree (${sandboxRoot}).`,
				};
			}

			const rewrittenCommand = `cd "${sandboxRoot}" && ${originalCommand}`;
			event.input.command = rewrittenCommand;
			return undefined;
		}

		return undefined;
	});
}
