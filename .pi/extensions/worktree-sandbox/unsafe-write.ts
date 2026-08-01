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
		if (
			typeof token === "string" &&
			(token === "cp" ||
				token === "mv" ||
				token === "touch" ||
				token === "tee" ||
				token === "install")
		) {
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
