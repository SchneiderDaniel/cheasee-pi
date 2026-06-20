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
	/** Bash file-reading commands that should use `read` tool instead. */
	private static readonly READ_BASH_CMDS: readonly string[] = Object.freeze([
		"cat",
		"head",
		"tail",
		"less",
		"more",
	]);

	/**
	 * Bash commands that modify files — triggers read cache invalidation.
	 */
	private static readonly FILE_MODIFY_SIGNALS: readonly string[] = Object.freeze([
		"sed",
		"echo",
		"cat",
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
	 * True if this is a pure, un-piped grep/rg call that should use
	 * the ripgrep_search tool instead.
	 *
	 * Logic matches harness-rules.ts isSearchInBash():
	 *  - Piped, && chained, ; chained → not search (pass through)
	 *  - Standalone grep/rg as first token → search
	 *  - Backtick grep/rg as first token → search (standalone only)
	 *  - Backtick grep/rg inside quoted string args → NOT search
	 */
	isSearch(): boolean {
		if (!this.raw) return false;

		// Only standalone calls — complex pipelines pass through
		if (!this.isStandalone()) {
			return false;
		}

		// For standalone commands, check first segment only
		if (this.segments.length === 0) return false;

		const firstSeg = this.segments[0];
		if (!firstSeg || firstSeg.tokens.length === 0) return false;

		const first = firstSeg.tokens[0];

		// Backtick patterns: `grep`, `rg` — search when first token
		// starts with backtick + grep/rg (actual command, not string arg)
		if (first.startsWith("`grep") || first.startsWith("`rg")) {
			return true;
		}

		return first === "grep" || first === "rg";
	}

	/**
	 * True if the command is a bash file-read that should use the
	 * `read` tool instead (cat/head/tail/less/more as first command).
	 *
	 * Logic matches harness-rules.ts isCatHeadTailInBash():
	 *  - Checks FIRST segment only (pipe-chain head)
	 *  - Redirect (write/append) → not a read
	 *  - Piped context → not a read
	 */
	isFileRead(): boolean {
		if (!this.raw) return false;

		if (this.segments.length === 0) return false;

		// Check the FIRST segment only (pipe-chain head)
		const firstSeg = this.segments[0];
		if (!firstSeg || firstSeg.tokens.length === 0) return false;

		// If first segment has redirect (write/append), it's not a read
		if (firstSeg.redirect) return false;

		// Check first token against READ_BASH_CMDS
		const firstToken = firstSeg.tokens[0];
		if (BashCommand.READ_BASH_CMDS.includes(firstToken)) {
			return true;
		}

		return false;
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
	 * NOTE: Redirect (>) does NOT suppress grep/rg search detection —
	 * a user piping grep results to a file should still be told to use
	 * ripgrep_search. However, redirect DOES suppress file-read detection
	 * (cat > file is a write, not a read).
	 */
	private detectMismatchKind(): "search" | "file-read" | null {
		if (!this.raw) return null;

		if (this.segments.length === 0) return null;

		// Search in bash (grep/rg as first token — standalone only, not piped)
		// Redirect does NOT suppress search detection
		if (this.isStandalone()) {
			for (const seg of this.segments) {
				if (seg.tokens.length >= 1) {
					const first = seg.tokens[0];
					// Backtick patterns: `grep`, `rg` — search when first token
					// starts with backtick + grep/rg (actual command, not string arg)
					if (first.startsWith("`grep") || first.startsWith("`rg")) {
						return "search";
					}
					if (first === "grep" || first === "rg") {
						return "search";
					}
				}
			}
		}

		// File read in bash (cat/head/tail — first segment, no redirect)
		const firstSeg = this.segments[0];
		if (firstSeg && firstSeg.tokens.length >= 1 && !firstSeg.redirect) {
			const first = firstSeg.tokens[0];
			for (const c of BashCommand.READ_BASH_CMDS) {
				if (first === c) {
					return "file-read";
				}
			}
		}

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
