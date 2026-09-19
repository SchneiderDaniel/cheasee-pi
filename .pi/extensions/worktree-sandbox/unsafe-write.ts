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
	isSideEffectFreeDevice,
	tokenizeCommand,
} from "./meaningful-token.ts";

/**
 * Content-sink safety: a target is safe when it is inside the sandbox OR is an
 * enumerated side-effect-free device (`/dev/null`) — the bytes are discarded
 * and opening it for output neither creates, renames, nor re-links a directory
 * entry. Used only by pure content sinks (redirects, `dd of=`, `tee`).
 *
 * Operations that can mutate the `/dev/null` directory entry or its metadata
 * (`cp --remove-destination`/`-b`/`--backup`, `mv`, `ln`, `install`, `touch`)
 * must use `isPathSafe` directly.
 */
function isContentSinkSafe(target: string, sandboxRoot: string): boolean {
	return isSideEffectFreeDevice(target) || isPathSafe(target, sandboxRoot);
}

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
			return checkWriteToken(tokenResult.value, command, sandboxRoot, true);
	}
}

/**
 * cp/mv/touch/tee/install branch: the destination is the last non-flag
 * argument of the command. `contentSink` is true only for `tee`, whose
 * destination open neither unlinks nor renames a directory entry. `cp` is
 * excluded even though it usually only truncates: `--remove-destination`
 * unlinks the destination before opening it, and `-b`/`--backup`/`--suffix`
 * rename it — so it is not side-effect-free for `/dev/null`.
 */
function checkCopyMove(
	tokens: ParseEntry[],
	index: number,
	command: string,
	sandboxRoot: string,
	contentSink: boolean,
): string | null {
	return checkWriteDest(tokens, index + 1, command, sandboxRoot, contentSink);
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
			const result = checkWriteToken(firstNonFlag, command, sandboxRoot, false);
			if (result !== null) return result;
		}
		// Last non-flag arg is the link name (or destination directory) —
		// the actual directory entry `ln` creates. Validate it too.
		if (lastNonFlag !== null && lastNonFlag !== firstNonFlag) {
			const result = checkWriteToken(lastNonFlag, command, sandboxRoot, false);
			if (result !== null) return result;
		}
		return null;
	}

	// For hard link (ln without -s), check the destination (last non-flag)
	return checkWriteDest(tokens, index + 1, command, sandboxRoot, false);
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
				const result = checkWriteToken(ofMatch[1]!, command, sandboxRoot, true);
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
	contentSink: boolean,
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
		const safe = contentSink
			? isContentSinkSafe(lastTarget, sandboxRoot)
			: isPathSafe(lastTarget, sandboxRoot);
		if (!safe) {
			return `outside sandbox: ${lastTarget}`;
		}
	}

	return null;
}

/**
 * Check a path token for write safety.
 *
 * `contentSink` is true for pure content sinks (redirect target, `dd of=`),
 * which may target a side-effect-free device; false for directory-entry
 * destinations (`ln`), which may not.
 */
function checkWriteToken(
	token: string,
	command: string,
	sandboxRoot: string,
	contentSink: boolean,
): string | null {
	if (token === "") {
		return command; // Unresolved variable
	}
	if (hasShellExpansion(token)) {
		return token;
	}
	const safe = contentSink ? isContentSinkSafe(token, sandboxRoot) : isPathSafe(token, sandboxRoot);
	if (!safe) {
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
			// Only pure content sinks may target a side-effect-free device.
			// cp can unlink the destination (--remove-destination) or rename it
			// (-b/--backup); mv/touch/install mutate or create the dir entry.
			const contentSink = token === "tee";
			const result = checkCopyMove(tokens, i, command, sandboxRoot, contentSink);
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
