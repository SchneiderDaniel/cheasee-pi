/**
 * Shell token analysis helpers for worktree-sandbox.
 *
 * Extracted from the triplicate isCommandStart/isCommandName pattern and
 * duplicate token-walking loops in index.ts to eliminate near-miss clone
 * maintenance burden.
 *
 * This module owns token-walking mechanics — operator detection, separator
 * classification, command-start detection. Security semantics (what constitutes
 * an unsafe path) remain in index.ts.
 *
 * Dependency rule: shell-tokens.ts imports ParseEntry from shell-quote and
 * has zero dependency on the pi runtime, agent-harness, or sandbox internals.
 */

import type { ParseEntry } from "shell-quote";

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Shell operators that start a new command in a pipeline.
 */
export const SEPARATORS = new Set(["|", "||", "|&", ";", ";;", "&&", "&"]);

// ─── Types ──────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Check if a token at the given index starts a new command.
 *
 * A token starts a command if it is the first token (index 0) or
 * the previous token is a separator operator (|, ||, |&, ;, ;;, &&, &).
 *
 * This pattern was duplicated identically in findSuspiciousArg (isCommandName),
 * findUnsafeCd (isStart), and findUnsafeWriteInBash (isStart). Extracted to
 * eliminate the triplicate clone.
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
 *
 * This loop pattern was duplicated in findUnsafeCd and findUnsafeWriteInBash.
 * Extracted with a discriminated union result so each caller can decide
 * separator/comment semantics without a callback or strategy parameter.
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
