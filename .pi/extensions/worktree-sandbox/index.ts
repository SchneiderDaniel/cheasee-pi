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
	return /[\$`~{*?\['";|&]/.test(token);
}

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
	let prevWasFlag = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// Handle glob operators (shell-quote produces { op: "glob", pattern } for wildcard patterns)
		if (typeof token === "object" && "op" in token && token.op === "glob") {
			const pattern = token.pattern ?? "";
			if (pattern && !isPathSafe(pattern, sandboxRoot)) {
				return `outside sandbox: ${pattern}`;
			}
			continue;
		}

		// Skip non-string tokens (operators, comments)
		if (typeof token !== "string") {
			continue;
		}

		// Skip command names (first token of each command)
		// A string is a command name if it's at position 0 or preceded by a separator
		if (isCommandStart(tokens, i)) {
			prevWasFlag = false;
			continue;
		}

		// Track and skip flags (starting with -)
		if (token.startsWith("-")) {
			prevWasFlag = true;
			continue;
		}

		// Empty token means unresolved variable
		if (token === "") {
			return command;
		}

		// Check if path resolves outside sandbox (before shell expansion,
		// so wildcards that resolve outside get "outside" in the reason)
		if (!isPathSafe(token, sandboxRoot)) {
			return `outside sandbox: ${token}`;
		}

		// Check for shell expansion syntax — skip for flag values
		// (e.g. -name "*.ts" where *.ts is a pattern, not a path)
		if (!prevWasFlag && hasShellExpansion(token)) {
			return token;
		}

		prevWasFlag = false;
	}
	return null;
}

/**
 * Scan the raw command string for cd with a variable/expansion target.
 *
 * shell-quote's parse() resolves variables ($HOME, etc.) before we can
 * inspect them, so we must detect expansion patterns in the raw text
 * before tokenization. Returns the raw target if it contains expansion
 * syntax, or null if the raw target looks safe (falls through to
 * tokenization-based checks).
 */
function findRawCdExpansion(command: string): string | null {
	// Match cd followed by a non-whitespace argument
	const match = command.match(/\bcd\s+(\S+)/);
	if (!match) return null;
	const rawTarget = match[1]!;

	// Variable patterns: $VAR, ${VAR}, $VAR/subdir, quoted "$VAR"
	if (/^\$/.test(rawTarget) || /^["']\$/.test(rawTarget)) {
		return rawTarget;
	}

	// Command substitution: $(...) or `...`
	if (rawTarget.includes("$(") || rawTarget.includes("`")) {
		return rawTarget;
	}

	// Tilde and quoted tilde: ~, ~/subdir, "~", '~', ~otheruser
	if (rawTarget === "~" || rawTarget.startsWith("~/") || rawTarget === '"~"' || rawTarget === "'~'" || rawTarget.startsWith("~")) {
		return rawTarget;
	}

	// Escaped constructs: \$HOME, \~, etc.
	if (rawTarget.startsWith("\\")) {
		return rawTarget;
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
	// RAW STRING SCAN: Detect variable/expansion patterns in cd target
	// before shell-quote resolves them away.
	const rawExpansion = findRawCdExpansion(command);
	if (rawExpansion !== null) {
		return rawExpansion;
	}
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
/**
 * Shared check for a destination-like token — used by cp/mv/touch/tee/install
 * to find the last non-flag string argument and check it.
 */
function checkWriteDest(tokens: ParseEntry[], startIndex: number, command: string, sandboxRoot: string): string | null {
	let lastTarget: string | null = null;

	for (let j = startIndex; j < tokens.length; j++) {
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
			return `outside sandbox: ${lastTarget}`;
		}
	}

	return null;
}

/**
 * Check a path token for write safety (redirect target, dd of=, etc.).
 */
function checkWriteToken(token: string, command: string, sandboxRoot: string): string | null {
	if (token === "") {
		return command; // Unresolved variable
	}
	if (hasShellExpansion(token)) {
		return token;
	}
	if (!isPathSafe(token, sandboxRoot)) {
		return `outside sandbox: ${token}`;
	}
	return null;
}

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
					const result = checkWriteToken(tokenResult.value, command, sandboxRoot);
					if (result !== null) return result;
					break;
				}
			}
		}

		// ── cp/mv/touch command detection ─────────────────────────
		if (typeof token === "string" && (token === "cp" || token === "mv" || token === "touch" || token === "tee" || token === "install")) {
			if (!isCommandStart(tokens, i)) continue;

			const result = checkWriteDest(tokens, i + 1, command, sandboxRoot);
			if (result !== null) return result;
		}

		// ── ln command detection ──────────────────────────────────
		// For ln -s (symlink), the first non-flag argument after -s is the
		// symlink target, which could point outside the sandbox.
		if (typeof token === "string" && token === "ln") {
			if (!isCommandStart(tokens, i)) continue;

			let isSymlink = false;
			let firstNonFlag: string | null = null;

			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j]!;

				if (typeof t === "object" && "op" in t) {
					if (SEPARATORS.has(t.op)) break;
					continue;
				}
				if (typeof t === "object" && "comment" in t) break;

				if (typeof t === "string") {
					if (t === "-s") {
						isSymlink = true;
						continue;
					}
					if (t.startsWith("-")) continue; // Other flags
					if (firstNonFlag === null) {
						firstNonFlag = t;
					} else if (isSymlink) {
						// Second non-flag arg (the link name) — stop scanning
						break;
					}
				}
			}

			if (isSymlink && firstNonFlag !== null) {
				const result = checkWriteToken(firstNonFlag, command, sandboxRoot);
				if (result !== null) return result;
			}

			// For hard link (ln without -s), check the destination (last non-flag)
			if (!isSymlink) {
				const result = checkWriteDest(tokens, i + 1, command, sandboxRoot);
				if (result !== null) return result;
			}
		}

		// ── dd command detection ──────────────────────────────────
		// dd uses of=<path> to specify the output file.
		if (typeof token === "string" && token === "dd") {
			if (!isCommandStart(tokens, i)) continue;

			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j]!;

				if (typeof t === "object" && "op" in t) {
					if (SEPARATORS.has(t.op)) break;
					continue;
				}
				if (typeof t === "object" && "comment" in t) break;

				if (typeof t === "string") {
					// Extract the path from of=<path>
					const ofMatch = t.match(/^of=(.+)/);
					if (ofMatch) {
						const result = checkWriteToken(ofMatch[1]!, command, sandboxRoot);
						if (result !== null) return result;
					}
				}
			}
		}
	}

	return null;
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
				ctx.ui.notify(
					`[sandbox] Blocked ${toolName} to outside worktree: ${originalPath}`,
					level,
				);
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

// ─── Shell token helpers (inlined from shell-tokens.ts) ─────────────
//
// These helpers (isCommandStart, findMeaningfulToken, SEPARATORS) were
// extracted to eliminate a triplicate isCommandStart/isCommandName/isStart
// clone across findSuspiciousArg, findUnsafeCd, and findUnsafeWriteInBash.
// They are inlined here because index.ts is the sole consumer — a dedicated
// module is not justified until a second consumer materializes.
// ──────────────────────────────────────────────────────────────────────

/**
 * Shell operators that start a new command in a pipeline.
 */
export const SEPARATORS = new Set(["|", "||", "|&", ";", ";;", "&&", "&"]);

/**
 * Result of findMeaningfulToken, giving callers full control over
 * how separator/comment/glob/exhausted cases are handled.
 *
 * - kind: "token" → a string word was found
 * - kind: "glob" → a glob operator ({ op: "glob" }) was found
 * - kind: "separator" → a command separator (|, ||, etc.) was found
 * - kind: "comment" → a shell comment was found
 * - kind: "exhausted" → no more tokens to scan
 */
export type MeaningfulTokenResult =
	| { kind: "token"; value: string; index: number }
	| { kind: "glob"; pattern: string; index: number }
	| { kind: "separator"; op: string; index: number }
	| { kind: "comment"; index: number }
	| { kind: "exhausted" };

/**
 * Check if a token at the given index starts a new command.
 *
 * A token starts a command if it is the first token (index 0) or
 * the previous token is a separator operator (|, ||, |&, ;, ;;, &&, &).
 */
export function isCommandStart(tokens: ParseEntry[], index: number): boolean {
	if (index === 0) return true;
	const prev = tokens[index - 1];
	return typeof prev === "object" && "op" in prev && SEPARATORS.has((prev as { op: string }).op);
}

/**
 * Find the next meaningful token starting from the given position.
 *
 * Scans through the token array skipping non-separator operators (>, >>, (, ), etc.)
 * but returns:
 * - glob operators immediately (they're semantically file patterns that affect safety)
 * - separator operators as-is (caller decides how to treat the command boundary)
 * - comments as-is (caller decides whether to treat as end-of-interest)
 * - string tokens (the next actual word argument)
 */
export function findMeaningfulToken(tokens: ParseEntry[], start: number): MeaningfulTokenResult {
	let j = start;
	while (j < tokens.length) {
		const nextToken = tokens[j]!;

		if (typeof nextToken === "object" && "op" in nextToken) {
			if (nextToken.op === "glob") {
				return { kind: "glob", pattern: nextToken.pattern ?? "", index: j };
			}
			if (SEPARATORS.has(nextToken.op)) {
				return { kind: "separator", op: nextToken.op, index: j };
			}
			// Skip non-separator operators (e.g., >, >>, (, ))
			j++;
			continue;
		}

		if (typeof nextToken === "object" && "comment" in nextToken) {
			return { kind: "comment", index: j };
		}

		// After filtering objects, remaining type must be string
		if (typeof nextToken !== "string") {
			// Unknown token type — skip defensively
			j++;
			continue;
		}

		// String token — meaningful word
		return { kind: "token", value: nextToken, index: j };
	}

	return { kind: "exhausted" };
}

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
