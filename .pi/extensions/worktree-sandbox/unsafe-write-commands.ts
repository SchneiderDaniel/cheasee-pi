// ─── Per-command write grammars ─────────────────────────────────
// One checker per command family: redirects, cp/mv/install/tee/touch, ln, dd.
// Split out of unsafe-write.ts (issue #2033); the entry point and its branch
// order stay in findUnsafeWriteInBash.

import type { ParseEntry } from "shell-quote";
import {
	SEPARATORS,
	findMeaningfulToken,
	hasShellExpansion,
	isPathSafe,
	isSideEffectFreeDevice,
} from "./meaningful-token.ts";
import { WRITE_COMMAND_GRAMMARS } from "./unsafe-write-grammars.ts";
import type { WriteGrammar } from "./unsafe-write-grammars.ts";
import { collectWriteTargets } from "./unsafe-write-targets.ts";

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
export function checkRedirect(
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
 * cp/mv/touch/tee/install branch: check every write target implied by the
 * command's grammar; the first unsafe target wins.
 */
export function checkWriteCommand(
	tokens: ParseEntry[],
	index: number,
	grammar: WriteGrammar,
	command: string,
	sandboxRoot: string,
): string | null {
	for (const target of collectWriteTargets(tokens, index + 1, grammar)) {
		const result = checkWriteToken(target, command, sandboxRoot, grammar.contentSink === true);
		if (result !== null) return result;
	}
	return null;
}

/**
 * A token that is *nothing but* an unresolved variable reference (`$OUT`,
 * `$1`, `$?`). tokenizeCommand collapses these to "", while
 * tokenizeCommandPreservingExpansions keeps the name; either way the shell —
 * not the detector — decides the path, so both fail closed with the command
 * string as the reason.
 */
const UNRESOLVED_VAR_ONLY = /^\$[A-Za-z_0-9*@#?$!-]*$/;

/**
 * Check a path token for write safety.
 *
 * `contentSink` is true for pure content sinks (redirect target, `dd of=`,
 * `tee` operands), which may target a side-effect-free device; false for
 * directory-entry destinations (`cp`/`mv`/`touch`/`install`/`ln`), which may not.
 */
export function checkWriteToken(
	token: string,
	command: string,
	sandboxRoot: string,
	contentSink: boolean,
): string | null {
	if (token === "" || UNRESOLVED_VAR_ONLY.test(token)) {
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
