/**
 * bash-query.ts — Pure detection functions for bash command classification.
 *
 * Inlines bash-command classification into a single pure module
 * (was extracted from agent-harness BashCommand class).
 *
 * Layer: domain — zero dependencies (no pi runtime, no agent-harness).
 * Pure functions with no I/O.
 *
 * Subsumes three overlapping detection code paths:
 *   1. BashCommand.isSearch() — standalone grep/rg
 *   2. isPipedFileGrep() — piped file→grep patterns
 *   3. isBashSearchOrRead() — turn-inefficiency classification
 *
 * READ_BASH_CMDS inlined to keep dependency-free.
 */

// ── Constants ──

const READ_CMDS = ["cat", "tail", "less", "more"] as const;

/** Bash commands that modify files — triggers read cache invalidation. */
const FILE_MODIFY_SIGNALS: readonly string[] = Object.freeze([
	"sed",
	"tee",
	"mv",
	"cp",
	"rm",
	"chmod",
	"dd",
]);

// ── Internal helpers ──

/** Get the first pipe-delimited segment of a command string. */
function firstSegment(cmd: string): string {
	const pipeIdx = cmd.indexOf("|");
	return pipeIdx >= 0 ? cmd.slice(0, pipeIdx).trim() : cmd.trim();
}

/** True if a segment has a write/append redirect operator (> or >>) as a token. */
function hasWriteRedirect(seg: string): boolean {
	const tokens = seg.split(/\s+/);
	return tokens.includes(">") || tokens.includes(">>");
}

/** Get the first non-empty token from a string. */
function firstToken(s: string): string | undefined {
	const tokens = s.split(/\s+/);
	return tokens.find((t) => t.length > 0);
}

// ── Public API ──

/**
 * True when a bash command is a search operation that should use
 * `ripgrep_search` tool instead.
 *
 * Returns true for:
 *  - Standalone grep/rg as first token (backtick variants included)
 *  - Piped file→grep: file-read command (cat/head/tail/less/more) piped to grep/rg
 *
 * Returns false for:
 *  - grep/rg chained with && or ;
 *  - Non-file pipe output piped to grep (e.g., ls | grep foo)
 *  - grep in quoted args, not first token
 *  - find (handled by isBashSearchOrRead)
 *  - Empty string
 */
/**
 * True when a bash command contains a `# bypass-harness` annotation
 * as a standalone comment token (not inside quoted strings).
 *
 * Token-wise parsing: strips single-quoted, double-quoted, and backtick-quoted
 * segments before scanning for the annotation as a standalone token.
 * Returns false on any ambiguity (heredocs, line continuations, empty/missing).
 *
 * This is a best-effort parser, not a full bash parser. For edge cases
 * (heredocs, \ continuations), use `input._harness.force` instead.
 *
 * @param cmd — raw bash command string (before shell evaluation)
 * @returns true if the unquoted portion contains standalone `# bypass-harness`
 */
export function hasBypassAnnotation(cmd: string): boolean {
	if (!cmd) return false;

	// Only check the first logical line (before any newline) to avoid
	// false positives from heredoc content and line continuations.
	// Heredocs and \ continuations fall through to false per architecture.
	const firstLine = cmd.split("\n")[0];
	if (!firstLine) return false;

	// Strip quoted segments to avoid false positives from annotation inside strings
	let stripped = firstLine;

	// Strip backtick-quoted segments: `...`
	stripped = stripped.replace(/`[^`]*`/g, "");

	// Strip double-quoted segments: "..."
	stripped = stripped.replace(/("(?:[^"\\]|\\.)*")/g, "");

	// Strip single-quoted segments: '...'
	stripped = stripped.replace(/('(?:[^'\\]|\\.)*')/g, "");

	// After stripping quotes, tokenize and look for standalone "# bypass-harness"
	const tokens = stripped.split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "#" && i + 1 < tokens.length && tokens[i + 1] === "bypass-harness") {
			return true;
		}
	}

	return false;
}

/**
 * True when a bash command is a search operation that should use
 * `ripgrep_search` tool instead.
 *
 * Returns true for:
 *  - Standalone grep/rg as first token (backtick variants included)
 *  - Piped file→grep: file-read command (cat/head/tail/less/more) piped to grep/rg
 *
 * Returns false for:
 *  - grep/rg chained with && or ;
 *  - Non-file pipe output piped to grep (e.g., ls | grep foo)
 *  - grep in quoted args, not first token
 *  - find (handled by isBashSearchOrRead)
 *  - Empty string
 */
export function isBashSearch(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase().trim();
	if (!lower) return false;

	// Piped file→grep: starts with file-read cmd and pipes to grep/rg
	// Subsumes isPipedFileGrep()
	for (const fileCmd of READ_CMDS) {
		if (lower.startsWith(fileCmd + " ") && /\|\s*grep\b|\|\s*rg\b/.test(lower)) {
			return true;
		}
	}

	// Standalone grep/rg only — no pipes, &&, or ;
	if (lower.includes("|") || lower.includes("&&") || lower.includes(";")) {
		return false;
	}

	const first = lower.split(/\s+/)[0];
	if (!first) return false;

	// Backtick variants: `grep`, `rg`
	if (first.startsWith("`grep") || first.startsWith("`rg")) {
		return true;
	}

	return first === "grep" || first === "rg";
}

/**
 * True when a bash command reads a file using cat/head/tail/less/more
 * where the `read` tool should be used instead.
 *
 * Matches `BashCommand.isFileRead()` semantics:
 *  - Checks FIRST pipe segment only
 *  - First token must be a known read command
 *  - Redirect (>, >>) in first segment suppresses detection
 *
 * Does NOT check for pipes (piped context can still be a read
 * if the first segment is a read command — e.g., `cat file | grep foo`).
 */
export function isBashFileRead(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase().trim();
	if (!lower) return false;

	const first = firstSegment(lower);
	if (!first) return false;

	// Redirect in first segment → not a read
	if (hasWriteRedirect(first)) return false;

	const token = firstToken(first);
	if (!token) return false;

	return (READ_CMDS as readonly string[]).includes(token);
}

/**
 * True when a bash command modifies files (triggers cache invalidation).
 *
 * Matches `BashCommand.isFileModify()` semantics:
 *  - Redirect operators (>, >>) anywhere in the command → modify
 *  - Known file-modifying commands (sed, tee, mv, cp, rm, chmod, dd)
 *    as first token in first pipe segment → modify
 *  - Empty/whitespace-only string → false
 */
export function isBashFileModify(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase();
	if (!lower) return false;

	// Redirect operators (>, >>) always modify files
	if (lower.includes(">")) return true;

	const first = firstSegment(lower);
	if (!first) return false;

	const token = firstToken(first);
	if (!token) return false;

	return FILE_MODIFY_SIGNALS.includes(token);
}

/**
 * Composite detection: true if the command is a search OR file read OR find.
 *
 * Used by `detectTurnInefficiency` to classify bash commands as
 * "not discovery" (search/read bash = not discovery, so turn may be
 * flagged if ≥15 calls without discovery events).
 *
 * Includes `find` as a search-like command (unlike `isBashSearch`
 * which excludes it) to match the existing behavior of the inline
 * `isBashSearchOrRead` function.
 */
export function isBashSearchOrRead(cmd: string): boolean {
	if (!cmd) return false;

	if (isBashSearch(cmd)) return true;
	if (isBashFileRead(cmd)) return true;

	// Find included only in the composite function (not in isBashSearch)
	const lower = cmd.toLowerCase().trim();
	const first = lower.split(/\s+/)[0];
	if (first === "find") return true;

	return false;
}
