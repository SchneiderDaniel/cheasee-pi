// ─── ln write grammar ───────────────────────────────────────────
// `ln -s` (first non-flag arg is the link target, last is the entry created)
// vs a hard link (last operand only). Split out of unsafe-write.ts (#2033).

import type { ParseEntry } from "shell-quote";
import { SEPARATORS } from "./meaningful-token.ts";
import { LN_HARD_LINK_GRAMMAR } from "./unsafe-write-grammars.ts";
import { checkWriteCommand, checkWriteToken } from "./unsafe-write-commands.ts";

export function checkLn(
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
	return checkWriteCommand(tokens, index, LN_HARD_LINK_GRAMMAR, command, sandboxRoot);
}
