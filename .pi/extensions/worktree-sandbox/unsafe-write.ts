/**
 * Worktree Sandbox — write-detector policy (findUnsafeWriteInBash).
 *
 * Branch order (redirects → cp/mv/touch/tee/install → ln → dd) is policy,
 * not code shape: it determines which token is reported first. Preserved
 * verbatim from the pre-split implementation — reordering breaks the
 * byte-identical verification contract.
 *
 * Split by responsibility (issue #2033): the grammars in
 * unsafe-write-grammars.ts, target collection in unsafe-write-targets.ts, the
 * per-command checkers in unsafe-write-commands.ts. This module keeps the
 * entry point and the branch order; the internals stay private to the
 * extension (index.ts re-exports only findUnsafeWriteInBash).
 */

import type { ParseEntry } from "shell-quote";
import { isCommandStart, tokenizeCommandPreservingExpansions } from "./meaningful-token.ts";
import { WRITE_COMMAND_GRAMMARS } from "./unsafe-write-grammars.ts";
import { checkRedirect, checkWriteCommand } from "./unsafe-write-commands.ts";
import { checkDd } from "./unsafe-write-dd.ts";
import { checkLn } from "./unsafe-write-ln.ts";

/**
 * Shell-aware file-write safety check for bash commands.
 *
 * Detects:
 * - Shell redirects: > file, >> file, 2> file, etc.
 * - cp/mv/install destinations (last operand or -t/--target-directory value)
 * - tee/touch targets (every operand — both are multi-destination)
 * - A command word the shell builds at run time (`c$X -t /out src`)
 *
 * Uses shell-quote parse() for correct operator detection, keeping expansion
 * provenance (tokenizeCommandPreservingExpansions) so a variable attached to an
 * option word is not silently dropped before the destination scan,
 * then applies hasShellExpansion and isPathSafe on all identified
 * destination paths.
 */
export function findUnsafeWriteInBash(command: string, sandboxRoot: string): string | null {
	const tokens = tokenizeCommandPreservingExpansions(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// ── Command word built by expansion ───────────────────────
		// `c$X -t /out src` runs `cp -t /out src`, and `$(which tee) /out`
		// runs tee: the shell picks the command word at run time, so no
		// grammar lookup below can match it. tokenizeCommandPreservingExpansions
		// keeps the `$` visible — fail closed instead of reading the token as a
		// harmless unknown command. Scoped to `$`/backtick so a literal `[`
		// (the test command) is not misread as an expansion.
		if (typeof token === "string" && /[$`]/.test(token) && isCommandStart(tokens, i)) {
			return command;
		}

		// ── Redirect branch: > file, >> file ──────────────────────
		if (typeof token === "object" && "op" in token && (token.op === ">" || token.op === ">>")) {
			const result = checkRedirect(tokens, i, command, sandboxRoot);
			if (result !== null) return result;
		}

		// ── cp/mv/touch/tee/install branch ────────────────────────
		if (typeof token === "string" && Object.hasOwn(WRITE_COMMAND_GRAMMARS, token)) {
			if (!isCommandStart(tokens, i)) continue;
			const result = checkWriteCommand(
				tokens,
				i,
				WRITE_COMMAND_GRAMMARS[token]!,
				command,
				sandboxRoot,
			);
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
