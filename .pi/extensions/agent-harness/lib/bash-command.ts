/**
 * bash-command.ts — Parse-and-query a bash command once.
 *
 * Wraps parseBashCmd() output and exposes query methods so callers
 * never need to parse the same command string more than once.
 *
 * Replacements for harness-rules.ts flat functions:
 *   isSearchInBash()       → BashCommand(cmd).isSearch()
 *   isCatHeadTailInBash()  → BashCommand(cmd).isFileRead()
 *   isFileModifyingBash()  → BashCommand(cmd).isFileModify()
 *   isStandaloneToolCall() → BashCommand(cmd).isStandalone()
 *   isLsInBash()           → BashCommand(cmd).isLs()
 *   detectMismatchAndSuggest() → BashCommand(cmd).detectMismatch()
 *   suggestRedirection()   → BashCommand(cmd).suggestRedirection()
 *
 */

import { isBashSearch, isBashFileRead } from "../../lib/bash-query.ts";

// ── Re-export the segment type ──

/** A single segment of a piped bash command. */
export interface BashSegment {
	/** Command tokens (cmd + args parsed outside quotes). */
	tokens: string[];
	/** Output redirect detected on segment (e.g., > or >>). */
	redirect?: "write" | "append" | "read";
}

// ── Tokenizer (extracted from harness-rules.ts) ──

/**
 * Tokenize a bash command string respecting quotes, pipes, and redirects.
 * Splits by pipe (|) outside single/double quotes.
 * Returns array of segments, each with tokens and optional redirect type.
 *
 * Handles:
 *  - Single and double quoted strings (pipe inside quotes = literal)
 *  - Tab and space token splitting
 *  - > (write) and >> (append) redirect detection
 *
 * Does NOT handle:
 *  - eval, exec, subshells ($(), ``)
 *  - Escaped quotes inside quotes
 *  - Heredoc bodies (<< delimiter is treated as redirect)
 */
export function parseBashCmd(cmd: string): BashSegment[] {
	if (!cmd) return [];

	const segments: BashSegment[] = [];
	let currentSegment: string[] = [];
	let currentToken = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	function flushToken() {
		if (currentToken) {
			currentSegment.push(currentToken);
			currentToken = "";
		}
	}

	function flushSegment() {
		flushToken();
		if (currentSegment.length === 0) return;

		const seg: BashSegment = { tokens: [...currentSegment] };

		// Check for redirect operators in tokens
		const idx = seg.tokens.findIndex((t) => t === ">" || t === ">>");
		if (idx >= 0) {
			const op = seg.tokens[idx];
			seg.redirect = op === ">>" ? "append" : "write";
			seg.tokens = seg.tokens.slice(0, idx);
		}

		segments.push(seg);
		currentSegment = [];
	}

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];

		// Handle quote toggling
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			currentToken += ch;
			continue;
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			currentToken += ch;
			continue;
		}

		// Inside quotes: collect everything literally
		if (inSingleQuote || inDoubleQuote) {
			currentToken += ch;
			continue;
		}

		// Pipe separator (outside quotes)
		if (ch === "|") {
			flushSegment();
			continue;
		}

		// Whitespace (space/tab) separator outside quotes
		if (ch === " " || ch === "\t") {
			flushToken();
			continue;
		}

		currentToken += ch;
	}

	// Flush remaining
	flushSegment();

	return segments;
}

// ── BashCommand class ──

/**
 * Parse a bash command once and query its structure.
 *
 * Example:
 * ```ts
 * const cmd = new BashCommand("grep foo bar.ts");
 * cmd.isSearch();     // true
 * cmd.isStandalone(); // true
 * ```
 */
export class BashCommand {
	/**
	 * Bash commands that modify files — triggers read cache invalidation.
	 */
	private static readonly FILE_MODIFY_SIGNALS: readonly string[] = Object.freeze([
		"sed",
		"tee",
		"mv",
		"cp",
		"rm",
		"chmod",
		"dd",
	]);

	/** The original command string. */
	readonly raw: string;
	/** Parsed segments (pipe-delimited parts of the command). */
	readonly segments: BashSegment[];

	/** Pre-computed lower-cased command. */
	private readonly lower: string;

	constructor(cmd: string) {
		this.raw = cmd;
		this.lower = cmd.toLowerCase();
		this.segments = parseBashCmd(cmd);
	}

	/**
	 * Create a BashCommand instance from a command string.
	 * Static factory that delegates to the constructor.
	 *
	 * Example:
	 * ```ts
	 * const cmd = BashCommand.from("grep foo");
	 * cmd.isSearch(); // true
	 * ```
	 */
	static from(cmd: string): BashCommand {
		return new BashCommand(cmd);
	}

	/**
	 * True if this bash command is a search operation that should use
	 * the ripgrep_search tool instead.
	 *
	 * Delegates to `isBashSearch` from lib/bash-query.ts for classification.
	 */
	isSearch(): boolean {
		return isBashSearch(this.raw);
	}

	/**
	 * True if the command is a bash file-read that should use the
	 * `read` tool instead (cat/head/tail/less/more as first command).
	 *
	 * Delegates to `isBashFileRead` from lib/bash-query.ts for classification.
	 */
	isFileRead(): boolean {
		return isBashFileRead(this.raw);
	}

	/**
	 * True if the command modifies files (triggers cache invalidation).
	 *
	 * Logic matches harness-rules.ts isFileModifyingBash():
	 *  - Redirect operators (>, >>) always modify files
	 *  - Known file-modifying commands (sed, mv, cp, rm, ...)
	 */
	isFileModify(): boolean {
		if (!this.raw) return false;

		// Redirect operators (>, >>) always modify files
		if (this.lower.includes(">")) return true;

		if (this.segments.length === 0) return false;

		// Check first token of first segment against known file-modifying commands
		const firstSeg = this.segments[0];
		if (!firstSeg || firstSeg.tokens.length === 0) return false;

		const firstToken = firstSeg.tokens[0];
		return BashCommand.FILE_MODIFY_SIGNALS.includes(firstToken);
	}

	/**
	 * True if the command is a simple standalone call
	 * (no pipes, && chains, or semicolons).
	 *
	 * Logic matches harness-rules.ts isStandaloneToolCall().
	 */
	isStandalone(): boolean {
		if (!this.raw) return false;
		// Complex commands with pipes, &&, or ; are not standalone
		if (this.raw.includes("|") || this.raw.includes("&&") || this.raw.includes(";")) {
			return false;
		}
		return true;
	}

	/**
	 * True if the command is `ls` or `ls <flags>`.
	 * Does NOT match `npm ls`, `lsass`, etc.
	 *
	 * Logic matches harness-rules.ts isLsInBash().
	 */
	isLs(): boolean {
		if (!this.raw) return false;

		// Exact match for bare "ls"
		if (this.raw.trim().toLowerCase() === "ls") return true;

		// Starts with "ls " followed by flags/paths — check first token is "ls"
		const tokens = this.raw.trim().split(/\s+/);
		if (tokens.length > 0 && tokens[0] === "ls") return true;

		return false;
	}

	/**
	 * Shared detection logic — identifies the kind of tool mismatch
	 * in a bash command.
	 *
	 * Returns:
	 *  - "search"    — grep/rg used where ripgrep_search is appropriate
	 *  - "file-read" — cat/head/tail/less/more used where read is appropriate
	 *  - null        — no recognized mismatch
	 *
	 * Used by both detectMismatch() (which maps to category/suggestion objects)
	 * and suggestRedirection() (which maps to tool-name strings).
	 *
	 * Delegates to isSearch()/isFileRead() which delegate to lib/bash-query.ts.
	 * NOTE: Redirect (>) does NOT suppress grep/rg search detection —
	 * a user piping grep results to a file should still be told to use
	 * ripgrep_search. However, redirect DOES suppress file-read detection
	 * (cat > file is a write, not a read).
	 */
	private detectMismatchKind(): "search" | "file-read" | null {
		if (!this.raw) return null;
		if (this.segments.length === 0) return null;

		if (this.isSearch()) return "search";
		if (this.isFileRead()) return "file-read";

		return null;
	}

	/**
	 * Detect tool mismatch and suggest alternative.
	 * Returns null if no mismatch detected.
	 *
	 * Delegates to detectMismatchKind() for shared detection logic,
	 * then maps the result to a { category, suggestion } object.
	 * Includes an ls-specific check not present in suggestRedirection().
	 */
	detectMismatch(): { category: string; suggestion: string } | null {
		const kind = this.detectMismatchKind();

		if (kind === "search") {
			return {
				category: "tool-mismatch",
				suggestion: "Use ripgrep_search tool for text search instead of bash grep/rg",
			};
		}

		if (kind === "file-read") {
			return {
				category: "tool-mismatch",
				suggestion: "Use read tool instead of bash cat/head/tail/less/more for file inspection",
			};
		}

		// ls (informational only — unique to detectMismatch)
		if (this.isLs()) {
			return {
				category: "tool-mismatch",
				suggestion:
					"Use bash ls for directory listing. For file contents, use read tool. For finding files, use ripgrep_search.",
			};
		}

		return null;
	}

	/**
	 * Suggest a redirection for a mismatched bash command.
	 * Returns the suggested tool name or null if no mismatch.
	 *
	 * Delegates to detectMismatchKind() for shared detection logic,
	 * then maps the result to a tool-name string.
	 */
	suggestRedirection(): string | null {
		const kind = this.detectMismatchKind();

		if (kind === "search") return "ripgrep_search";
		if (kind === "file-read") return "read";

		return null;
	}
}
