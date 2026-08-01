/**
 * Worktree Sandbox — cd-detector policy (findUnsafeCd + findRawCdExpansion).
 *
 * findRawCdExpansion MUST stay in this module, co-located with findUnsafeCd:
 * shell-quote's parse() resolves variables ($HOME, etc.) to "" during
 * tokenization, so the raw pre-scan has to run before tokenization. Moving
 * the two-phase scan across modules re-opens the `cd $HOME` bypass.
 */

import {
	findMeaningfulToken,
	hasShellExpansion,
	isCommandStart,
	isPathSafe,
	tokenizeCommand,
} from "./meaningful-token.ts";

/**
 * Scan the raw command string for cd with a variable/expansion target.
 *
 * shell-quote's parse() resolves variables ($HOME, etc.) before we can
 * inspect them, so we must detect expansion patterns in the raw text
 * before tokenization. Returns the raw target if it contains expansion
 * syntax, or null if the raw target looks safe (falls through to
 * tokenization-based checks).
 */
function findRawCdExpansion(command: string): string | null {
	// Match cd followed by a non-whitespace argument
	const match = command.match(/\bcd\s+(\S+)/);
	if (!match) return null;
	const rawTarget = match[1]!;

	// Variable patterns: $VAR, ${VAR}, $VAR/subdir, quoted "$VAR"
	if (/^\$/.test(rawTarget) || /^["']\$/.test(rawTarget)) {
		return rawTarget;
	}

	// Command substitution: $(...) or `...`
	if (rawTarget.includes("$(") || rawTarget.includes("`")) {
		return rawTarget;
	}

	// Tilde and quoted tilde: ~, ~/subdir, "~", '~', ~otheruser
	if (
		rawTarget === "~" ||
		rawTarget.startsWith("~/") ||
		rawTarget === '"~"' ||
		rawTarget === "'~'" ||
		rawTarget.startsWith("~")
	) {
		return rawTarget;
	}

	// Escaped constructs: \$HOME, \~, etc.
	if (rawTarget.startsWith("\\")) {
		return rawTarget;
	}

	return null;
}

/**
 * Shell-aware cd command safety check.
 *
 * Uses shell-quote parse() to correctly identify command boundaries
 * (handling pipes, &&, ||, ; etc.) and extract cd targets with proper
 * quoting awareness. Then applies hasShellExpansion and isPathSafe on
 * each cd target.
 *
 * Handles all 5 identified bypass vectors:
 * 1. Variable expansion ($HOME, $PWD/../../escape)
 * 2. Command substitution ($(...), backticks)
 * 3. Tilde expansion (~/escape)
 * 4. Pipe prefix (echo | cd /escape)
 * 5. Bare cd (cd, cd ; echo)
 */
export function findUnsafeCd(command: string, sandboxRoot: string): string | null {
	// RAW STRING SCAN: Detect variable/expansion patterns in cd target
	// before shell-quote resolves them away.
	const rawExpansion = findRawCdExpansion(command);
	if (rawExpansion !== null) {
		return rawExpansion;
	}
	const tokens = tokenizeCommand(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		// Skip non-string tokens (operators, comments)
		if (typeof token !== "string") {
			continue;
		}

		// Check if this token starts a command (is a 'cd' command)
		// A string starts a command if it's at position 0 or preceded by a separator
		if (token === "cd") {
			if (!isCommandStart(tokens, i)) {
				continue; // 'cd' is not a command, e.g. path argument
			}

			// Find the next meaningful token after cd (the cd target)
			const tokenResult = findMeaningfulToken(tokens, i + 1);
			switch (tokenResult.kind) {
				case "exhausted":
				case "separator":
				case "comment":
					return "<HOME>";
				case "glob":
					return tokenResult.pattern || command;
				case "token": {
					let nextToken = tokenResult.value;
					let tokenIndex = tokenResult.index;

					// Handle -- option separator(s) by advancing past them
					while (nextToken === "--") {
						const next = findMeaningfulToken(tokens, tokenIndex + 1);
						if (next.kind === "exhausted" || next.kind === "separator" || next.kind === "comment") {
							return "<HOME>";
						}
						if (next.kind === "glob") {
							return next.pattern || command;
						}
						nextToken = next.value;
						tokenIndex = next.index;
					}

					// String token — this is the cd target
					if (nextToken === "") {
						return "<HOME>"; // Unresolved variable ($VAR with no env value)
					}

					if (nextToken === "-") {
						return "<previous-dir>"; // Previous directory — always potentially unsafe
					}

					if (hasShellExpansion(nextToken)) {
						return nextToken; // Shell expansion syntax detected
					}

					if (!isPathSafe(nextToken, sandboxRoot)) {
						return nextToken; // Path resolves outside sandbox
					}

					break; // This cd is safe
				}
			}
		}
	}

	return null;
}
