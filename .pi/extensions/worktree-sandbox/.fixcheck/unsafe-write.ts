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
	tokenizeCommand,
} from "./meaningful-token.ts";

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
			return checkWriteToken(tokenResult.value, command, sandboxRoot);
	}
}

/**
 * Declarative write grammar for commands whose file operands are not all
 * destinations in the same position.
 *
 * - `operands: "all"`  → every non-flag operand is a write target (tee, touch)
 * - `operands: "last"` → only the final operand is a destination (cp, mv, install)
 * - `targetDirectoryOptions` → option whose value is the destination directory
 *   (`-t DIR`, `-tDIR`, `--target-directory=DIR`)
 * - `valueOptions` → option whose following token is a value, not a path
 *   (prevents false blocks such as `touch -r /etc/hosts ok.txt`)
 */
type WriteGrammar = {
	operands: "all" | "last";
	targetDirectoryOptions?: readonly string[];
	valueOptions?: readonly string[];
};

const WRITE_COMMAND_GRAMMARS: Record<string, WriteGrammar> = {
	cp: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-S", "--suffix"],
	},
	mv: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-S", "--suffix"],
	},
	install: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"],
	},
	tee: { operands: "all" }, // -a/-i/-p/--output-error take no separate value
	touch: { operands: "all", valueOptions: ["-d", "-r", "-t", "--date", "--reference", "--time"] },
};

// Hard-link `ln` (no `-s`) is single-destination like `cp`: the last operand.
const LN_HARD_LINK_GRAMMAR: WriteGrammar = { operands: "last" };

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
 * True when a token consumed as an option *value* cannot be trusted to stay a
 * single word: glob words expand to one-or-more paths and shell-expansion
 * markers (or an empty unresolved variable) mean the operand count after
 * expansion is unknown. Only the first expanded word is the option's value —
 * the rest become real operands (`touch -r /etc/* ok.txt` → `touch -r /etc/a
 * /etc/b ok.txt`), so the value must fail closed.
 */
function valueNeedsArityGuard(value: string): boolean {
	return value === "" || hasShellExpansion(value);
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
function collectWriteTargets(
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
			const eq = t.indexOf("=");
			if (eq !== -1) {
				// Attached long-option value: --target-directory=DIR, --suffix=.bak
				const name = t.slice(0, eq);
				const value = t.slice(eq + 1);
				if (grammar.targetDirectoryOptions?.includes(name)) {
					explicit.push(value);
				} else if (
					grammar.valueOptions?.includes(name) &&
					valueNeedsArityGuard(value)
				) {
					// Glob/expansion value may expand to several words. Only the
					// first is the option's value; the rest land in operand
					// position, so the value must fail closed.
					explicit.push(value);
				}
				continue;
			}
			if (grammar.targetDirectoryOptions?.includes(t)) {
				const value = tokenText(tokens[j + 1]);
				if (value !== null) {
					explicit.push(value);
					j++; // consume the option value
				}
				continue;
			}
			if (grammar.valueOptions?.includes(t)) {
				const value = tokenText(tokens[j + 1]);
				if (value !== null) {
					// touch -r /etc/* ok.txt → bash expands `/etc/*` into extra
					// operands that touch then writes; check the value itself.
					if (valueNeedsArityGuard(value)) explicit.push(value);
					j++; // consume the value
				}
				continue;
			}
			if (!t.startsWith("--")) {
				// Short-option bundle: walk the letters left to right. A
				// value-taking option swallows the rest of the bundle, so a `t`
				// after it is that option's value, not a bundled `-t`. A `t`
				// itself takes the attached remainder or the next token as its
				// destination directory (-t/etc/out, -at /etc/out).
				const letters = t.slice(1);
				for (let k = 0; k < letters.length; k++) {
					const letter = `-${letters[k]}`;
					if (grammar.targetDirectoryOptions?.includes(letter)) {
						const attached = letters.slice(k + 1);
						const next = tokenText(tokens[j + 1]);
						if (attached !== "") {
							explicit.push(attached);
						} else if (next !== null) {
							explicit.push(next);
							j++; // consume the option value
						}
						break;
					}
					if (grammar.valueOptions?.includes(letter)) {
						const rest = letters.slice(k + 1);
						if (rest === "") {
							const value = tokenText(tokens[j + 1]);
							if (value !== null) {
								if (valueNeedsArityGuard(value)) explicit.push(value);
								j++; // consume the value
							}
						} else if (valueNeedsArityGuard(rest)) {
							explicit.push(rest); // attached value may expand to operands
						}
						break; // value swallows the remainder of the bundle
					}
				}
			}
			continue; // Any other flag
		}

		operands.push(t);
	}

	const selected = grammar.operands === "all" ? operands : operands.slice(-1);
	return [...explicit, ...selected];
}

/**
 * cp/mv/touch/tee/install branch: check every write target implied by the
 * command's grammar; the first unsafe target wins.
 */
function checkWriteCommand(
	tokens: ParseEntry[],
	index: number,
	grammar: WriteGrammar,
	command: string,
	sandboxRoot: string,
): string | null {
	for (const target of collectWriteTargets(tokens, index + 1, grammar)) {
		const result = checkWriteToken(target, command, sandboxRoot);
		if (result !== null) return result;
	}
	return null;
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
			const result = checkWriteToken(firstNonFlag, command, sandboxRoot);
			if (result !== null) return result;
		}
		// Last non-flag arg is the link name (or destination directory) —
		// the actual directory entry `ln` creates. Validate it too.
		if (lastNonFlag !== null && lastNonFlag !== firstNonFlag) {
			const result = checkWriteToken(lastNonFlag, command, sandboxRoot);
			if (result !== null) return result;
		}
		return null;
	}

	// For hard link (ln without -s), check the destination (last non-flag)
	return checkWriteCommand(tokens, index, LN_HARD_LINK_GRAMMAR, command, sandboxRoot);
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
				const result = checkWriteToken(ofMatch[1]!, command, sandboxRoot);
				if (result !== null) return result;
			}
		}
	}
	return null;
}

/**
 * Check a path token for write safety (redirect target, dd of=, etc.).
 */
function checkWriteToken(token: string, command: string, sandboxRoot: string): string | null {
	if (token === "") {
		return command; // Unresolved variable
	}
	if (hasShellExpansion(token)) {
		return token;
	}
	if (!isPathSafe(token, sandboxRoot)) {
		return `outside sandbox: ${token}`;
	}
	return null;
}

/**
 * Shell-aware file-write safety check for bash commands.
 *
 * Detects:
 * - Shell redirects: > file, >> file, 2> file, etc.
 * - cp/mv/install destinations (last operand or -t/--target-directory value)
 * - tee/touch targets (every operand — both are multi-destination)
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
