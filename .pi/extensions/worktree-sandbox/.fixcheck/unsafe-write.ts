/**
 * Worktree Sandbox — write-detector policy (findUnsafeWriteInBash).
 *
 * Branch order (redirects → cp/mv/touch/tee/install → ln → dd) is policy,
 * not code shape: it determines which token is reported first. Preserved
 * verbatim from the pre-split implementation — reordering breaks the
 * byte-identical verification contract.
 */

import type { ParseEntry } from "shell-quote";
import {
	SEPARATORS,
	findMeaningfulToken,
	hasShellExpansion,
	isCommandStart,
	isPathSafe,
	tokenizeCommand,
} from "./meaningful-token.ts";

/**
 * Redirect branch: `> file` / `>> file` — the next meaningful token after
 * the operator is the write target.
 */
function checkRedirect(
	tokens: ParseEntry[],
	index: number,
	command: string,
	sandboxRoot: string,
): string | null {
	const tokenResult = findMeaningfulToken(tokens, index + 1);
	switch (tokenResult.kind) {
		case "exhausted":
		case "separator":
		case "comment":
			return null; // No target found before separator
		case "glob":
			return tokenResult.pattern || command;
		case "token":
			return checkWriteToken(tokenResult.value, command, sandboxRoot);
	}
}

/**
 * cp/mv/touch/tee/install branch: the destination is the last non-flag
 * argument of the command.
 */
function checkCopyMove(
	tokens: ParseEntry[],
	index: number,
	command: string,
	sandboxRoot: string,
): string | null {
	return checkWriteDest(tokens, index + 1, command, sandboxRoot);
}

/**
 * ln branch: for `ln -s` the first non-flag argument is the symlink target
 * (which could point outside the sandbox); for a hard link only the
 * destination (last non-flag argument) is checked.
 */
function checkLn(
	tokens: ParseEntry[],
	index: number,
	command: string,
	sandboxRoot: string,
): string | null {
	let isSymlink = false;
	let firstNonFlag: string | null = null;
	let lastNonFlag: string | null = null;

	for (let j = index + 1; j < tokens.length; j++) {
		const t = tokens[j]!;

		if (typeof t === "object" && "op" in t) {
			if (SEPARATORS.has(t.op)) break;
			continue;
		}
		if (typeof t === "object" && "comment" in t) break;

		if (typeof t === "string") {
			if (t === "-s" || t === "--symbolic") {
				isSymlink = true;
				continue;
			}
			if (t.startsWith("-")) {
				// Combined short-option bundles (e.g. -sT, -sv) count as symlink
				// mode when they contain lowercase 's' (ln has no other option
				// letter containing 's').
				if (!t.startsWith("--") && t.includes("s")) isSymlink = true;
				continue; // Other flags
			}
			if (firstNonFlag === null) {
				firstNonFlag = t;
			}
			lastNonFlag = t;
		}
	}

	if (isSymlink) {
		// First non-flag arg is the symlink target (escape-vector guard).
		if (firstNonFlag !== null) {
			const result = checkWriteToken(firstNonFlag, command, sandboxRoot);
			if (result !== null) return result;
		}
		// Last non-flag arg is the link name (or destination directory) —
		// the actual directory entry `ln` creates. Validate it too.
		if (lastNonFlag !== null && lastNonFlag !== firstNonFlag) {
			const result = checkWriteToken(lastNonFlag, command, sandboxRoot);
			if (result !== null) return result;
		}
		return null;
	}

	// For hard link (ln without -s), check the destination (last non-flag)
	return checkWriteDest(tokens, index + 1, command, sandboxRoot);
}

/**
 * dd branch: `of=<path>` specifies the output file.
 */
function checkDd(
	tokens: ParseEntry[],
	index: number,
	command: string,
	sandboxRoot: string,
): string | null {
	for (let j = index + 1; j < tokens.length; j++) {
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
	return null;
}

/**
 * Shared check for a destination-like token — used by cp/mv/touch/tee/install
 * to find the last non-flag string argument and check it.
 */
function checkWriteDest(
	tokens: ParseEntry[],
	startIndex: number,
	command: string,
	sandboxRoot: string,
): string | null {
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

		// ── Redirect branch: > file, >> file ──────────────────────
		if (typeof token === "object" && "op" in token && (token.op === ">" || token.op === ">>")) {
			const result = checkRedirect(tokens, i, command, sandboxRoot);
			if (result !== null) return result;
		}

		// ── cp/mv/touch/tee/install branch ────────────────────────
		if (
			typeof token === "string" &&
			(token === "cp" ||
				token === "mv" ||
				token === "touch" ||
				token === "tee" ||
				token === "install")
		) {
			if (!isCommandStart(tokens, i)) continue;
			const result = checkCopyMove(tokens, i, command, sandboxRoot);
			if (result !== null) return result;
		}

		// ── ln branch ─────────────────────────────────────────────
		if (typeof token === "string" && token === "ln") {
			if (!isCommandStart(tokens, i)) continue;
			const result = checkLn(tokens, i, command, sandboxRoot);
			if (result !== null) return result;
		}

		// ── dd branch ─────────────────────────────────────────────
		if (typeof token === "string" && token === "dd") {
			if (!isCommandStart(tokens, i)) continue;
			const result = checkDd(tokens, i, command, sandboxRoot);
			if (result !== null) return result;
		}
	}

	return null;
}
