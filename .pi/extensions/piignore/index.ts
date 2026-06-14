/**
 * piignore — Blocks AI access to sensitive files via .piignore patterns
 *
 * Reads .piignore (gitignore format) from project root. Prevents the AI
 * from reading, writing, editing, or inspecting paths matching ignore
 * patterns. Keeps .env, secrets/, and other sensitive data safe.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Safe-default patterns for untrusted projects
// ---------------------------------------------------------------------------

/**
 * Hardcoded patterns used when the project is not trusted.
 * Prevents attacker-controlled .piignore from controlling which files
 * the AI can access. These always block common secret-bearing files.
 *
 * Exported for testing (test imports via TDD gate verification).
 */
export const SAFE_DEFAULT_BLOCK: readonly string[] = [
	"*.env",
	".env.*",
	"secrets/",
	"**/*.pem",
	"**/*.key",
];

// ---------------------------------------------------------------------------
// Lightweight gitignore pattern matcher (Node built-ins only)
// ---------------------------------------------------------------------------

interface IgnoreEntry {
	root: string;
	patterns: Pattern[];
}

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

/**
 * Convert a single gitignore pattern line to a RegExp.
 * Supports: * ** ? ! (negation) and trailing / for directories.
 */
function patternToRegex(pattern: string): Pattern {
	let p = pattern;
	let negate = false;

	if (p.startsWith("!")) {
		negate = true;
		p = p.slice(1).trim();
	}
	if (p === "") return { regex: /(?!)/, negate };

	// Handle gitignore leading escape sequences per spec
	// \# → literal # (not comment), \! → literal ! (not negation), \\ → literal \
	if (p.startsWith("\\#") || p.startsWith("\\!")) {
		p = p.slice(1); // strip backslash, keep escaped char
	} else if (p.startsWith("\\\\")) {
		p = p.slice(1); // strip one backslash of the pair, keep one
	}

	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}

	const hasSlash = p.includes("/") || p.startsWith("**");

	// Strip leading / (gitignore root anchor) — relative paths never have it
	if (hasSlash && p.startsWith("/")) p = p.slice(1);

	// Step 1a: Extract and preserve bracket expressions so the regex
	//          escape step doesn't mangle [ and ] as literals.
	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	// Step 1b: Escape regex meta-characters except *, ?, [, ]
	r = r.replace(/[.+^${}()|\\]/g, "\\$&");

	// Step 1c: Escape unclosed [ (bracket without matching ]) as literal
	r = r.replace(/\[/g, "\\[");

	// Step 2: Replace **/ and ** with placeholders (so later * replacement
	//         doesn't mangle the injected regex syntax)
	r = r.replace(/\*\*\//g, "\x00G\x00"); // **/ -> placeholder
	r = r.replace(/\*\*$/g, "\x00GS\x00"); // ** at end -> placeholder

	// Step 3: Replace *, ? with regex equivalents
	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");

	// Step 4: Replace placeholders with actual regex
	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

	// Step 4b: Restore bracket expressions
	for (let i = 0; i < bracketExprs.length; i++) {
		let expr = bracketExprs[i];
		// [!...] → [^...]  (gitignore negation to regex negation)
		if (expr.startsWith("[!")) {
			expr = "[^" + expr.slice(2);
		}
		// Empty bracket [] → escape as literal \[\]
		if (expr === "[]") {
			expr = "\\[\\]";
		}
		r = r.split(`\x00B${i}\x00`).join(expr);
	}

	// Step 5: Anchor
	if (hasSlash) {
		r = "^" + r;
	} else {
		r = "(^|.*/)" + r;
	}
	if (dirOnly) r += "(/.*)?";
	r += "$";

	return { regex: new RegExp(r), negate };
}

/** Parse a .piignore file content into Pattern[]. */
function parseIgnore(content: string): Pattern[] {
	const patterns: Pattern[] = [];
	for (let line of content.split("\n")) {
		line = line.trim();
		if (line === "" || line.startsWith("#")) continue;
		patterns.push(patternToRegex(line));
	}
	return patterns;
}

/** Walk up from cwd to filesystem root, collecting .piignore files. */
function loadPiIgnore(cwd: string): IgnoreEntry[] {
	const entries: IgnoreEntry[] = [];
	let dir = cwd;
	while (true) {
		const ignorePath = path.join(dir, ".piignore");
		if (fs.existsSync(ignorePath)) {
			entries.push({
				root: dir,
				patterns: parseIgnore(fs.readFileSync(ignorePath, "utf-8")),
			});
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return entries;
}

/**
 * Check if a path is ignored by any .piignore file.
 * Handles both relative and absolute paths.
 * Respects negation patterns (!).
 */
function isIgnored(targetPath: string, entries: IgnoreEntry[], cwd: string): boolean {
	const absPath = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(cwd, targetPath);

	let ignored = false;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const rel = path.relative(entry.root, absPath);
		if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
			const relForMatch = rel.replace(/\\/g, "/");
			for (const pat of entry.patterns) {
				if (pat.regex.test(relForMatch)) {
					ignored = !pat.negate;
				}
			}
		}
	}

	return ignored;
}

/**
 * Build IgnoreEntry[] from SAFE_DEFAULT_BLOCK patterns rooted at cwd.
 * Used when the project is not trusted — skips .piignore entirely.
 */
function getSafeDefaultEntries(cwd: string): IgnoreEntry[] {
	return [
		{
			root: cwd,
			patterns: SAFE_DEFAULT_BLOCK.map(patternToRegex),
		},
	];
}

// ---------------------------------------------------------------------------
// Helpers: extract paths from tool inputs
// ---------------------------------------------------------------------------

/** Check a single path against ignore patterns. Returns the matched path or null. */
function checkPath(
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
): string | null {
	if (!targetPath) return null;
	if (isIgnored(targetPath, entries, cwd)) return targetPath;
	return null;
}

// ---------------------------------------------------------------------------
// Bash tokenization helpers
// ---------------------------------------------------------------------------

interface BashToken {
	text: string;
	quoted: boolean;
}

/**
 * Split a bash command string into tokens, tracking whether each was quoted.
 * Only the outermost quoting pair is tracked (double or single).
 * Nested quotes inside a quoted token are literal characters.
 */
function tokenizeBashCommand(command: string): BashToken[] {
	const tokens: BashToken[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let quoted = false;

	function flush() {
		if (current || quoted) {
			tokens.push({ text: current, quoted });
		}
		current = "";
		quoted = false;
	}

	function emit(text: string) {
		flush();
		tokens.push({ text, quoted: false });
	}

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (ch === "'") {
			flush();
			inSingle = true;
		} else if (ch === '"') {
			flush();
			inDouble = true;
		} else if (ch === " " || ch === "\t") {
			flush();
		} else if (ch === ";") {
			emit(";");
		} else if (ch === "|") {
			if (command[i + 1] === "|") {
				emit("||");
				i++;
			} else {
				emit("|");
			}
		} else if (ch === "&") {
			if (command[i + 1] === "&") {
				emit("&&");
				i++;
			} else {
				current += ch;
			}
		} else {
			current += ch;
		}
	}

	flush();

	return tokens;
}

/**
 * Split a token array into segments at shell operator boundaries.
 * Shell operators (&&, ||, ;, |) delimit separate commands.
 * Operators inside quotes are not boundaries.
 */
function segmentTokens(tokens: BashToken[]): BashToken[][] {
	const segments: BashToken[][] = [];
	let current: BashToken[] = [];

	for (const t of tokens) {
		if (!t.quoted && (t.text === "&&" || t.text === "||" || t.text === ";" || t.text === "|")) {
			segments.push(current);
			current = [];
		} else {
			current.push(t);
		}
	}
	segments.push(current);

	return segments;
}

/**
 * Extract the command name from a bash command (first non-option token).
 */
function getCommandName(command: string): string {
	const tokens = tokenizeBashCommand(command);
	return getCommandNameFromTokens(tokens);
}

/**
 * Extract the command name from a list of tokens (first non-option, non-operator token).
 */
function getCommandNameFromTokens(tokens: BashToken[]): string {
	for (const t of tokens) {
		if (t.quoted) continue;
		if (t.text.startsWith("-")) continue;
		if (t.text === "|" || t.text === ";" || t.text === "&&" || t.text === "||") continue;
		return t.text;
	}
	return "";
}

/**
 * Determine if a token looks like a file path that should be checked.
 * Excludes known non-path patterns (URLs, npm scoped packages, standalone tilde,
 * option flags, shell operators) and all tokens when command is echo/printf.
 *
 * Safety principle: quoting does not change file identity after bash quote removal.
 * A quoted "cat .env" resolves to the same file path as unquoted cat .env.
 * The echo/printf guard and option-flag prefix filter handle the legitimate
 * string-literal cases (echo "some.log", --body 'comment text').
 * Backtick content is command substitution (e.g. \`some.command\`).
 */
function isPathLike(token: BashToken, commandName: string): boolean {
	const t = token.text;

	// Backtick chars indicate command substitution, not file paths
	if (t.includes("`")) return false;

	// Option flags and shell operators are never paths
	if (t.startsWith("-")) return false;
	if (
		t === "|" ||
		t === ";" ||
		t === "&&" ||
		t === "||" ||
		t === ">" ||
		t === ">>" ||
		t === "<" ||
		t === "2>" ||
		t === "2>>" ||
		t === "&>" ||
		t === "1>"
	)
		return false;

	// Standalone tilde is shell home shortcut, not a file path
	if (t === "~") return false;

	// npm/yarn scoped package names (@scope/...) are not local paths
	if (t.startsWith("@")) return false;

	// URLs with scheme prefix are not local paths
	// Matches http://, https://, ftp://, s3://, file://, etc.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;

	// Echo-like commands take string literals, never file paths
	if (commandName === "echo" || commandName === "printf") return false;

	// Path-like character heuristic for non-excluded tokens
	return t.includes("/") || t.includes(".") || t.includes("~");
}

/**
 * Extract potential file/directory paths from a bash command string.
 * Tokenizes the command, splits into segments at shell separators,
 * and checks each segment independently with its own command name.
 */
function checkBashCommand(command: string, entries: IgnoreEntry[], cwd: string): string | null {
	const tokens = tokenizeBashCommand(command);
	const segments = segmentTokens(tokens);

	for (const segment of segments) {
		const commandName = getCommandNameFromTokens(segment);
		const pathLike = segment.filter((t) => isPathLike(t, commandName));

		for (const t of pathLike) {
			const result = checkPath(t.text, entries, cwd);
			if (result) return result;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Defer sync I/O — load on first use, not at module init
	let cachedCwd: string | null = null;
	let entries: IgnoreEntry[] | null = null;

	function getEntries(cwd: string): IgnoreEntry[] {
		if (!entries || cachedCwd !== cwd) {
			entries = loadPiIgnore(cwd);
			cachedCwd = cwd;
		}
		return entries;
	}

	// Reload patterns on /reload
	pi.on("resources_discover", (_event, ctx) => {
		try {
			entries = loadPiIgnore(ctx.cwd);
			cachedCwd = ctx.cwd;
		} catch (err) {
			console.error("[piignore] resources_discover error:", err);
			entries = null;
			cachedCwd = null;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			// ── Trust gate ──────────────────────────────────────────
			// If ctx.isProjectTrusted() is unavailable (older Pi),
			// throws, or returns false/undefined, treat as untrusted
			// and fall back to safe-default patterns. This prevents
			// attacker-controlled .piignore from being honored.
			let isTrusted = false;
			try {
				isTrusted = (ctx as any).isProjectTrusted?.() === true;
			} catch {
				isTrusted = false;
			}

			const ignoreEntries = isTrusted ? getEntries(ctx.cwd) : getSafeDefaultEntries(ctx.cwd);

			let blockedPath: string | null = null;

			if (isToolCallEventType("read", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("write", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("edit", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("grep", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("find", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("ls", event)) {
				blockedPath = checkPath(event.input.path, ignoreEntries, ctx.cwd);
			} else if (isToolCallEventType("bash", event)) {
				blockedPath = checkBashCommand(event.input.command, ignoreEntries, ctx.cwd);
			} else {
				return;
			}

			if (blockedPath) {
				const source = isTrusted ? ".piignore" : "safe-default";
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked by ${source}: ${blockedPath}`, "warning");
				}
				return {
					block: true,
					reason: ctx.hasUI
						? `Path "${blockedPath}" matches ${source} patterns`
						: `Path "${blockedPath}" matches ${source} patterns (${(ctx as any).mode ?? "unknown"} mode — no notification shown)`,
				};
			}
		} catch (err) {
			console.error("[piignore] Internal error:", err);
			return {
				block: true,
				reason: "Piignore internal error — blocked for safety",
			};
		}
	});
}
