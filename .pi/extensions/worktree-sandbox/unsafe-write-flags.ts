// ─── Option-value targets ───────────────────────────────────────
// Which write targets a flag implies: `-t DIR` / `--target-directory=DIR`
// destination directories, and option values that can expand into extra
// operands. Split out of unsafe-write.ts (issue #2033) so the operand scan
// stays readable.

import { hasShellExpansion } from "./meaningful-token.ts";
import {
	bundleTargets,
	NO_TARGETS,
	valueNeedsArityGuard,
	type FlagOutcome,
} from "./unsafe-write-bundles.ts";
import type { WriteGrammar } from "./unsafe-write-grammars.ts";

/**
 * Resolve one flag token. `next` is the following token's text, or null.
 * Attached values (`--target-directory=DIR`, `--suffix=.bak`) never consume the
 * next token; separate values (`-t DIR`, `-r FILE`) do.
 */
export function flagTargets(t: string, next: string | null, grammar: WriteGrammar): FlagOutcome {
	const eq = t.indexOf("=");
	if (eq !== -1) {
		// Attached long-option value: --target-directory=DIR, --suffix=.bak
		const name = t.slice(0, eq);
		const value = t.slice(eq + 1);
		if (grammar.targetDirectoryOptions?.includes(name)) {
			return { targets: [value], consumesNext: false };
		}
		if (grammar.valueOptions?.includes(name) && valueNeedsArityGuard(value)) {
			// Glob/expansion value may expand to several words. Only the
			// first is the option's value; the rest land in operand
			// position, so the value must fail closed.
			return { targets: [value], consumesNext: false };
		}
		return NO_TARGETS;
	}
	if (grammar.targetDirectoryOptions?.includes(t)) {
		return next === null ? NO_TARGETS : { targets: [next], consumesNext: true };
	}
	if (grammar.valueOptions?.includes(t)) {
		if (next === null) return NO_TARGETS;
		// touch -r /etc/* ok.txt → bash expands `/etc/*` into extra
		// operands that touch then writes; check the value itself.
		return { targets: valueNeedsArityGuard(next) ? [next] : [], consumesNext: true };
	}
	if (!t.startsWith("--")) return bundleTargets(t.slice(1), next, grammar);
	return NO_TARGETS; // Any other long flag
}
