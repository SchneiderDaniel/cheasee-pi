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
import { parse } from "shell-quote";
import type { ParseEntry } from "shell-quote";
import { SEPARATORS, isCommandStart, findMeaningfulToken } from "./shell-tokens.ts";

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

// ─── Shell-aware parsing ───────────────────────────────────────────

/**
 * Tokenize a shell command using shell-quote parse().
 * Returns a flat array of tokens where:
 * - Strings are literal words/arguments
 * - { op: string } objects are operators (|, ||, &&, ;, >, >>, etc.)
 * - { comment: string } objects are comments
 * - Variables ($VAR) resolve to their env value (or "" if not in env)
 */
export function tokenizeCommand(cmd: string): ParseEntry[] {
	return parse(cmd) as ParseEntry[];
}

/**
 * Check if a path token contains shell expansion syntax.
 * Detects: $, `, ~, {, *, ?, [ which bash would expand before resolving paths.
 */
export function hasShellExpansion(token: string): boolean {
	return /[\$`~{*?\[]/.test(token);
}

// SEPARATORS moved to shell-tokens.ts — re-exported below.

/**
 * Shell-aware suspicious argument detection.
 *
 * Scans all command arguments for shell expansion syntax or paths
 * that would escape the sandbox. Returns the first suspicious token
 * found, or null if all arguments are safe.
 *
 * This is a general-purpose version of findUnsafeCd that checks all
 * arguments in all commands, not just cd targets.
 */
export function findSuspiciousArg(command: string, sandboxRoot: string): string | null {
	if (!command || !command.trim()) return null;

	const tokens = tokenizeCommand(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// Skip non-string tokens (operators, comments)
		if (typeof token !== "string") {
			continue;
		}

		// Skip command names (first token of each command)
		// A string is a command name if it's at position 0 or preceded by a separator
		if (isCommandStart(tokens, i)) {
			continue;
		}

		// Skip flags (starting with -)
		if (token.startsWith("-")) {
			continue;
		}

		// Empty token means unresolved variable
		if (token === "") {
			return command;
		}

		// Check for shell expansion syntax
		if (hasShellExpansion(token)) {
			return token;
		}

		// Check if path resolves outside sandbox
		if (!isPathSafe(token, sandboxRoot)) {
			return token;
		}
	}
	return null;
}

/**
 * Shell-aware cd command safety check.
 *
 * Uses shell-quote parse() to correctly identify command boundaries
 * (handling pipes, &&, ||, ; etc.) and extract cd targets with proper
 * quoting awareness. Then applies hasShellExpansion and isPathSafe on
 * each cd target.
 *
 * Handles all 5 identified bypass vectors:
 * 1. Variable expansion ($HOME, $PWD/../../escape)
 * 2. Command substitution ($(...), backticks)
 * 3. Tilde expansion (~/escape)
 * 4. Pipe prefix (echo | cd /escape)
 * 5. Bare cd (cd, cd ; echo)
 */
export function findUnsafeCd(command: string, sandboxRoot: string): string | null {
	const tokens = tokenizeCommand(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// Skip non-string tokens (operators, comments)
		if (typeof token !== "string") {
			continue;
		}

		// Check if this token starts a command (is a 'cd' command)
		// A string starts a command if it's at position 0 or preceded by a separator
		if (token === "cd") {
			if (!isCommandStart(tokens, i)) {
				continue; // 'cd' is not a command, e.g. path argument
			}

			// Find the next meaningful token after cd (the cd target)
			const tokenResult = findMeaningfulToken(tokens, i + 1);
			switch (tokenResult.kind) {
				case "exhausted":
				case "separator":
				case "comment":
					return "<HOME>";
				case "glob":
					return tokenResult.pattern || command;
				case "token": {
					let nextToken = tokenResult.value;
					let tokenIndex = tokenResult.index;

					// Handle -- option separator(s) by advancing past them
					while (nextToken === "--") {
						const next = findMeaningfulToken(tokens, tokenIndex + 1);
						if (next.kind === "exhausted" || next.kind === "separator" || next.kind === "comment") {
							return "<HOME>";
						}
						if (next.kind === "glob") {
							return next.pattern || command;
						}
						nextToken = next.value;
						tokenIndex = next.index;
					}

					// String token — this is the cd target
					if (nextToken === "") {
						return "<HOME>"; // Unresolved variable ($VAR with no env value)
					}

					if (nextToken === "-") {
						return "<previous-dir>"; // Previous directory — always potentially unsafe
					}

					if (hasShellExpansion(nextToken)) {
						return nextToken; // Shell expansion syntax detected
					}

					if (!isPathSafe(nextToken, sandboxRoot)) {
						return nextToken; // Path resolves outside sandbox
					}

					break; // This cd is safe
				}
			}
		}
	}

	return null;
}

/**
 * Shell-aware file-write safety check for bash commands.
 *
 * Detects:
 * - Shell redirects: > file, >> file, 2> file, etc.
 * - cp/mv destination paths (last non-flag argument)
 * - touch target paths
 *
 * Uses shell-quote parse() for correct operator detection,
 * then applies hasShellExpansion and isPathSafe on all identified
 * destination paths.
 */
export function findUnsafeWriteInBash(command: string, sandboxRoot: string): string | null {
	const tokens = tokenizeCommand(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// ── Redirect detection ────────────────────────────────────
		// Detect { op: ">" } or { op: ">>" } tokens
		if (typeof token === "object" && "op" in token && (token.op === ">" || token.op === ">>")) {
			// Next non-operator token is the redirect target
			const tokenResult = findMeaningfulToken(tokens, i + 1);
			switch (tokenResult.kind) {
				case "exhausted":
				case "separator":
				case "comment":
					break; // No target found before separator
				case "glob":
					return tokenResult.pattern || command;
				case "token": {
					const nextToken = tokenResult.value;
					// String token — this is the redirect target
					if (nextToken === "") {
						return command; // Unresolved variable
					}

					if (hasShellExpansion(nextToken)) {
						return nextToken;
					}

					if (!isPathSafe(nextToken, sandboxRoot)) {
						return nextToken;
					}

					break;
				}
			}
		}

		// ── cp/mv/touch command detection ─────────────────────────
		if (typeof token === "string" && (token === "cp" || token === "mv" || token === "touch")) {
			if (!isCommandStart(tokens, i)) continue;

			// Find the last non-flag, non-operator, non-comment token
			// For cp/mv: the last such token is the destination
			// For touch: the last such token is the file to create
			let lastTarget: string | null = null;

			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j]!;

				if (typeof t === "object" && "op" in t) {
					if (SEPARATORS.has(t.op)) break;
					continue; // Skip non-separator operators
				}

				if (typeof t === "object" && "comment" in t) break;

				if (typeof t === "string") {
					if (t.startsWith("-")) continue; // Skip flags
					lastTarget = t;
				}
			}

			if (lastTarget !== null) {
				if (lastTarget === "") {
					return command; // Unresolved variable
				}
				if (hasShellExpansion(lastTarget)) {
					return lastTarget;
				}
				if (!isPathSafe(lastTarget, sandboxRoot)) {
					return lastTarget;
				}
			}
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

export { SEPARATORS, isCommandStart, findMeaningfulToken } from "./shell-tokens.ts";
export type { MeaningfulTokenResult } from "./shell-tokens.ts";

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
