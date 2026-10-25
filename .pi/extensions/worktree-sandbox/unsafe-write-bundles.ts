// ─── Short-option bundles ───────────────────────────────────────
// `-at /etc/out` style bundles: which letter is a destination-directory or
// value-taking option, and where its value ends. Split out of unsafe-write.ts
// (issue #2033).

import { hasShellExpansion } from "./meaningful-token.ts";
import type { WriteGrammar } from "./unsafe-write-grammars.ts";

export interface FlagOutcome {
	/** Targets this flag contributes (destination dirs and unsafe values). */
	targets: string[];
	/** True when the flag consumed the following token as its value. */
	consumesNext: boolean;
}

export const NO_TARGETS: FlagOutcome = { targets: [], consumesNext: false };

/**
 * True when a token consumed as an option *value* cannot be trusted to stay a
 * single word: glob words expand to one-or-more paths and shell-expansion
 * markers (or an empty unresolved variable) mean the operand count after
 * expansion is unknown. Only the first expanded word is the option's value —
 * the rest become real operands (`touch -r /etc/* ok.txt` → `touch -r /etc/a
 * /etc/b ok.txt`), so the value must fail closed.
 */
export function valueNeedsArityGuard(value: string): boolean {
	return value === "" || hasShellExpansion(value);
}

/**
 * Short-option bundle: walk the letters left to right. A value-taking option
 * swallows the rest of the bundle, so a `t` after it is that option's value,
 * not a bundled `-t`. A `t` itself takes the attached remainder or the next
 * token as its destination directory (-t/etc/out, -at /etc/out).
 */
export function bundleTargets(
	letters: string,
	next: string | null,
	grammar: WriteGrammar,
): FlagOutcome {
	for (let k = 0; k < letters.length; k++) {
		const letter = `-${letters[k]}`;
		if (grammar.targetDirectoryOptions?.includes(letter)) {
			const attached = letters.slice(k + 1);
			if (attached !== "") return { targets: [attached], consumesNext: false };
			if (next !== null) return { targets: [next], consumesNext: true };
			return NO_TARGETS;
		}
		if (grammar.valueOptions?.includes(letter)) {
			const rest = letters.slice(k + 1);
			if (rest === "") {
				if (next === null) return NO_TARGETS;
				return { targets: valueNeedsArityGuard(next) ? [next] : [], consumesNext: true };
			}
			// attached value may expand to operands
			return { targets: valueNeedsArityGuard(rest) ? [rest] : [], consumesNext: false };
		}
	}
	return NO_TARGETS;
}
