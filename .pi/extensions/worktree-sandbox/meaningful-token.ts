/**
 * Worktree Sandbox — shell-token helpers (lowest layer of the detector graph).
 *
 * Owns the shell-quote surface (tokenizeCommand), token classification
 * (isCommandStart, SEPARATORS, MeaningfulTokenResult), the shell-walk
 * primitive (findMeaningfulToken), argument-level safety helpers
 * (hasShellExpansion, findSuspiciousArg), and the path-containment
 * primitives (isPathWithinSandbox, isPathSafe) that every detector shares.
 *
 * This module must stay free of imports from sibling detector modules —
 * unsafe-cd.ts, unsafe-write.ts, and index.ts all import from here, and the
 * runtime is CJS where a require() cycle would yield undefined exports.
 */

import { resolve as resolvePath } from "node:path";
import { parse } from "shell-quote";
import type { ParseEntry } from "shell-quote";

// ─── Path containment ──────────────────────────────────────────────

export function isPathWithinSandbox(absolutePath: string, sandboxRoot: string): boolean {
	return absolutePath === sandboxRoot || absolutePath.startsWith(sandboxRoot + "/");
}

export function isPathSafe(target: string, sandboxRoot: string): boolean {
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

// ─── Shell token helpers ───────────────────────────────────────────

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
