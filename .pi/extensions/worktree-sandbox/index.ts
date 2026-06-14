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
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

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

function isPathWithinSandbox(absolutePath: string, sandboxRoot: string): boolean {
	return absolutePath === sandboxRoot || absolutePath.startsWith(sandboxRoot + "/");
}

function isPathSafe(target: string, sandboxRoot: string): boolean {
	if (target.startsWith("/")) {
		return isPathWithinSandbox(target, sandboxRoot);
	}
	const resolved = resolvePath(sandboxRoot, target);
	return isPathWithinSandbox(resolved, sandboxRoot);
}

export function findUnsafeCd(command: string, sandboxRoot: string): string | null {
	// Match cd with optional argument, using negative lookahead to avoid
	// capturing chain operators (&&, ||, ;, |) as cd targets.
	// The lookahead and optional group work together:
	//   - "cd subdir"   → \s+ matches space, lookahead passes, (\S+) captures "subdir"
	//   - "cd && pwd"   → \s+ matches space, lookahead fails → group skipped → undefined → bare cd
	//   - "cd" (EOL)    → \s+ fails (no space after cd), group skipped → undefined → bare cd
	const cdRegex = /(?:^|&&|;|\|\|)\s*cd(?:\s+(?!&&|\|\||;|\|)(\S+))?/g;
	let match: RegExpExecArray | null;
	while ((match = cdRegex.exec(command)) !== null) {
		const target = match[1]; // undefined when bare cd or when lookahead rejects chain operator
		if (target === "-") continue;

		// Bare cd goes to $HOME — block it
		if (!target) {
			return "<HOME>";
		}

		// Block shell expansions — they bypass static path resolution
		if (target.includes("~") || target.includes("$") || target.includes("`")) {
			return target;
		}

		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}
	return null;
}

/**
 * Detect bash file writes to absolute paths outside the sandbox.
 * Catches: echo > /abs/path, cp /src /abs/dst, mv /src /abs/dst, touch /abs/file
 */
function findUnsafeWriteInBash(command: string, sandboxRoot: string): string | null {
	// Shell redirects: > /abs/path or >> /abs/path (with optional fd number like 2>)
	const redirectRegex = /(?:^|[^a-zA-Z])(?:\d*[>]|[>][>])\s*(\/[^\s"'|;&]+)/g;
	let match: RegExpExecArray | null;
	while ((match = redirectRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}

	// cp destination: `cp <src> <dst>` — the last non-flag arg is the destination
	const cpMatch = command.match(/\bcp\s+.*\s+(\/[^\s"'|;&]+)\s*$/);
	if (cpMatch && !isPathSafe(cpMatch[1]!, sandboxRoot)) {
		return cpMatch[1]!;
	}

	// mv destination: same as cp
	const mvMatch = command.match(/\bmv\s+.*\s+(\/[^\s"'|;&]+)\s*$/);
	if (mvMatch && !isPathSafe(mvMatch[1]!, sandboxRoot)) {
		return mvMatch[1]!;
	}

	// touch path
	const touchRegex = /\btouch\s+(\/[^\s"'|;&]+)/g;
	while ((match = touchRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}

	return null;
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
				ctx.ui.notify(
					`[sandbox] Blocked ${toolName} to outside worktree: ${originalPath}`,
					"warning",
				);
			}
			return {
				block: true,
				reason: `Path "${originalPath}" is outside the worktree. All ${blockNoun} must stay within the worktree.`,
			};
		}
		return undefined;
	}

	const rewritten = resolvePath(sandboxRoot, originalPath);
	if (!isPathWithinSandbox(rewritten, sandboxRoot)) {
		return { block: true, reason: `Path "${originalPath}" resolves outside the worktree.` };
	}
	event.input.path = rewritten;
	return undefined;
}

// ─── Export ─────────────────────────────────────────────────────────

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
