/**
 * bash-query.ts — Pure detection functions for bash command classification.
 *
 * Inlines bash-command classification into a single pure module
 * (was extracted from agent-harness BashCommand class).
 *
 * Layer: domain — zero dependencies (no pi runtime, no agent-harness).
 * Pure functions with no I/O.
 *
 * Subsumes two overlapping detection code paths:
 *   1. BashCommand.isSearch() — standalone grep/rg
 *   2. isPipedFileGrep() — piped file→grep patterns
 *
 * READ_BASH_CMDS inlined to keep dependency-free.
 */

// ── Constants ──

/** Commands that read from a file — used for pipe-to-grep detection in isBashSearch. */
const READ_CMDS = ["cat", "tail", "less", "more"] as const;

/**
 * Commands that should redirect to the `read` tool.
 * Tail is excluded because `tail -N` is O(N) from EOF via seek,
 * while the `read` tool is O(file size) — it loads the entire file.
 * Including tail would make the harness force an expensive full-file read
 * for what would be a cheap seek-from-end operation.
 *
 * ponytail: rare tail -n +1 / tail -c +1 bypass is accepted;
 * argument-parsing for full-file tail variants adds complexity not worth the cost.
 */
const READ_REDIRECT_CMDS = ["cat", "less", "more"] as const;

/**
 * Import the single source of truth for the bypass annotation literal.
 * Defined in agent-harness rules module; consumed here as token parts.
 */
import { BYPASS_ANNOTATION } from "../agent-harness/lib/harness-rules.ts";

/** Hash token and annotation token derived from BYPASS_ANNOTATION constant. */
const [HASH_TOKEN, ANNOTATION_TOKEN] = BYPASS_ANNOTATION.split(/\s+/);

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
		if (tokens[i] === HASH_TOKEN && i + 1 < tokens.length && tokens[i + 1] === ANNOTATION_TOKEN) {
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
 *  - find → false (not a search, stays pass-through)
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
 * True when a bash command reads a file using cat/less/more
 * where the `read` tool should be used instead.
 *
 * Tail is excluded because `tail -N` is O(N) from EOF, while the `read` tool
 * is O(file size) — it loads the entire file into memory before slicing.
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

	return (READ_REDIRECT_CMDS as readonly string[]).includes(token);
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
