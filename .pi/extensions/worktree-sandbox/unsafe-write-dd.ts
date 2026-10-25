// ─── dd write grammar ───────────────────────────────────────────
// `of=<path>` is dd's output file; every other token is input. Split out of
// unsafe-write.ts (issue #2033).

import type { ParseEntry } from "shell-quote";
import { SEPARATORS } from "./meaningful-token.ts";
import { checkWriteToken } from "./unsafe-write-commands.ts";

/**
 * dd branch: `of=<path>` specifies the output file.
 */
export function checkDd(
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
