// ── Bash sub-key derivation ─────────────────────────────────────
// The cascade counter's composite identity: `tool` + this sub-key, so `git
// status` and `git commit` are different commands while `cat a` stays `cat`.
// Split out of agent-harness.ts (issue #2033); re-exported from there.

import { MULTI_VERB_TOOLS } from "./harness-rules.ts";

/**
 * Extract bash sub-key for sub-command-aware cascade detection.
 * Multi-verb CLIs (git, npm, docker, gh, etc.) use first 2 tokens.
 * Single-verb commands (cat, echo, ls, etc.) use first token only.
 * Empty → undefined.
 */
export function getBashSubKey(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;

	const tokens = trimmed.split(/\s+/);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) return undefined;

	// Determine which tokens form the sub-command
	// If command starts with cd <path> &&, strip navigation prefix
	let subKeyTokens: string[];
	if (tokens[0] === "cd") {
		const andAndIndex = tokens.indexOf("&&");
		if (andAndIndex > 0) {
			// Extract subKey from tokens after && (the real command)
			subKeyTokens = tokens.slice(andAndIndex + 1);
		} else {
			// Bare cd (no &&) — cd IS the command
			subKeyTokens = tokens;
		}
	} else {
		subKeyTokens = tokens;
	}

	if (subKeyTokens.length === 0) return undefined;

	if (MULTI_VERB_TOOLS.has(subKeyTokens[0]!) && subKeyTokens.length > 1) {
		return `${subKeyTokens[0]} ${subKeyTokens[1]}`;
	}

	return subKeyTokens[0]!;
}
