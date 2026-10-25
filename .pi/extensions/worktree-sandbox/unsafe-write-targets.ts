// ─── Write-target collection ────────────────────────────────────
// Which argv tokens a write command's grammar makes targets. Split out of
// unsafe-write.ts (issue #2033).

import type { ParseEntry } from "shell-quote";
import { SEPARATORS } from "./meaningful-token.ts";
import { flagTargets } from "./unsafe-write-flags.ts";
import type { WriteGrammar } from "./unsafe-write-grammars.ts";

/**
 * Text of a token for write-target purposes: strings verbatim, glob words by
 * pattern. shell-quote turns `/etc/*` into `{ op: "glob", pattern: "/etc/*" }`;
 * the pattern keeps its glob metacharacter, so checkWriteToken rejects it
 * (hasShellExpansion) — glob operands fail closed instead of being dropped.
 */
function tokenText(entry: ParseEntry | undefined): string | null {
	if (typeof entry === "string") return entry;
	if (typeof entry === "object" && "op" in entry && entry.op === "glob") return entry.pattern;
	return null;
}

/**
 * Collect every write target a command's argv implies.
 *
 * Scans the remainder of the current command, skipping non-separator
 * operators (so `tee a >log b` still sees `b` as an operand), stopping at
 * SEPARATORS/comments, honouring `--` end-of-options, consuming `valueOptions`
 * values (glob/expansion values are themselves checked — see
 * `valueNeedsArityGuard`), and extracting `targetDirectoryOptions` values. Glob
 * words count as operands/values (fail closed), not as skippable operators.
 */
export function collectWriteTargets(
	tokens: ParseEntry[],
	startIndex: number,
	grammar: WriteGrammar,
): string[] {
	const explicit: string[] = []; // destination-directory option values
	const operands: string[] = [];
	let endOfOptions = false;

	for (let j = startIndex; j < tokens.length; j++) {
		const entry = tokens[j]!;

		if (typeof entry === "object" && "op" in entry) {
			if (SEPARATORS.has(entry.op)) break;
			// Skip non-separator operators, but keep glob words in play.
			if (entry.op !== "glob") continue;
		} else if (typeof entry === "object" && "comment" in entry) {
			break;
		}

		const t = tokenText(entry);
		if (t === null) continue;

		if (!endOfOptions && t === "--") {
			endOfOptions = true;
			continue;
		}

		if (!endOfOptions && t.startsWith("-")) {
			const flag = flagTargets(t, tokenText(tokens[j + 1]), grammar);
			explicit.push(...flag.targets);
			if (flag.consumesNext) j++; // consume the option value
			continue; // Any other flag
		}

		operands.push(t);
	}

	const selected = grammar.operands === "all" ? operands : operands.slice(-1);
	return [...explicit, ...selected];
}
