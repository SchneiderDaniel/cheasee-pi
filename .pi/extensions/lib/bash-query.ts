/**
 * bash-query.ts — Pure detection functions for bash command classification.
 *
 * Extracted from agent-harness BashCommand class and session-advice
 * inline detectors to eliminate cross-extension direct imports.
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

const READ_CMDS = ["cat", "head", "tail", "less", "more"] as const;

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
