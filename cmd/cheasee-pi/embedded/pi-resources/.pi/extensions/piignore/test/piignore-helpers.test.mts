/**
 * Tests for piignore bash command tokenization and path-like detection.
 *
 * Tests the extracted helpers:
 *   - tokenizeBashCommand(command)
 *   - isPathLike(token, commandName)
 *   - checkBashCommand(command, entries, cwd)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-helpers.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/piignore.ts after fix)
// ═══════════════════════════════════════════════════════════════════════

interface BashToken {
	text: string;
	quoted: boolean;
}

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

interface IgnoreEntry {
	root: string;
	patterns: Pattern[];
}

// ═══════════════════════════════════════════════════════════════════════
// Inline helpers (mirror source at .pi/extensions/piignore.ts)
// ═══════════════════════════════════════════════════════════════════════

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

	// Step 1a: Extract and preserve bracket expressions
	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	// Step 1b: Escape regex meta-characters except *, ?, [, ]
	r = r.replace(/[.+^${}()|\\]/g, "\\$&");

	// Step 1c: Escape unclosed [ (bracket without matching ]) as literal
	r = r.replace(/\[/g, "\\[");

	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");

	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");

	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

	// Step 4b: Restore bracket expressions
	for (let i = 0; i < bracketExprs.length; i++) {
		let expr = bracketExprs[i];
		if (expr.startsWith("[!")) {
			expr = "[^" + expr.slice(2);
		}
		if (expr === "[]") {
			expr = "\\[\\]";
		}
		r = r.split(`\x00B${i}\x00`).join(expr);
	}

	if (hasSlash) {
		r = "^" + r;
	} else {
		r = "(^|.*/)" + r;
	}
	if (dirOnly) r += "(/.*)?";
	r += "$";

	return { regex: new RegExp(r), negate };
}

function parseIgnore(content: string): Pattern[] {
	const patterns: Pattern[] = [];
	for (let line of content.split("\n")) {
		line = line.trim();
		if (line === "" || line.startsWith("#")) continue;
		patterns.push(patternToRegex(line));
	}
	return patterns;
}

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

function checkPath(
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
): string | null {
	if (!targetPath) return null;
	if (isIgnored(targetPath, entries, cwd)) return targetPath;
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers to be tested (will be implemented in source file)
// Replace with imports when source file exports them.
// For now, inline the expected implementation so tests define the contract.
// ═══════════════════════════════════════════════════════════════════════

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
			// NOTE: does not handle \\" (escaped backslash + quote delimiter) — acceptable for P3, see issue #949.
			if (ch === '"' && (i === 0 || command[i - 1] !== "\\")) {
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
	// All tokens after echo/printf are skipped
	if (commandName === "echo" || commandName === "printf") return false;

	// Path-like character heuristic (same as before for non-excluded tokens)
	return t.includes("/") || t.includes(".") || t.includes("~");
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
		if (t.quoted) continue; // quoted tokens are not the command
		if (t.text.startsWith("-")) continue; // skip option flags
		if (t.text === "|" || t.text === ";" || t.text === "&&" || t.text === "||") continue;
		return t.text;
	}
	return "";
}

/**
 * Check a bash command for paths matching piignore patterns.
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

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

import path from "node:path";

describe("tokenizeBashCommand", () => {
	it("splits simple command by spaces", () => {
		assert.deepStrictEqual(tokenizeBashCommand("ls -la /tmp"), [
			{ text: "ls", quoted: false },
			{ text: "-la", quoted: false },
			{ text: "/tmp", quoted: false },
		]);
	});

	it("handles single-quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand("echo 'hello world'"), [
			{ text: "echo", quoted: false },
			{ text: "hello world", quoted: true },
		]);
	});

	it("handles double-quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand('echo "hello world"'), [
			{ text: "echo", quoted: false },
			{ text: "hello world", quoted: true },
		]);
	});

	it("handles nested single quote inside double quotes", () => {
		assert.deepStrictEqual(tokenizeBashCommand(`echo "nested 'quote' inside"`), [
			{ text: "echo", quoted: false },
			{ text: "nested 'quote' inside", quoted: true },
		]);
	});

	it("handles empty quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand("''"), [{ text: "", quoted: true }]);
	});

	it("returns empty array for empty string", () => {
		assert.deepStrictEqual(tokenizeBashCommand(""), []);
	});

	it("returns empty array for whitespace-only string", () => {
		assert.deepStrictEqual(tokenizeBashCommand("   "), []);
	});

	it("preserves pipe as separate token", () => {
		assert.deepStrictEqual(tokenizeBashCommand("cat file | grep pattern"), [
			{ text: "cat", quoted: false },
			{ text: "file", quoted: false },
			{ text: "|", quoted: false },
			{ text: "grep", quoted: false },
			{ text: "pattern", quoted: false },
		]);
	});

	it("handles multiple quoted arguments in echo", () => {
		assert.deepStrictEqual(tokenizeBashCommand('echo "some.log" "file.tar"'), [
			{ text: "echo", quoted: false },
			{ text: "some.log", quoted: true },
			{ text: "file.tar", quoted: true },
		]);
	});

	it("handles escaped double quotes inside double-quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand('"hello \\"world\\""'), [
			{ text: 'hello \\"world\\"', quoted: true },
		]);
	});

	it("handles escaped double quote at end of double-quoted string", () => {
		assert.deepStrictEqual(tokenizeBashCommand('"text\\"more"'), [
			{ text: 'text\\"more', quoted: true },
		]);
	});

	it("empty double-quoted string still produces one empty token", () => {
		assert.deepStrictEqual(tokenizeBashCommand('""'), [{ text: "", quoted: true }]);
	});
});

describe("isPathLike", () => {
	it("rejects standalone tilde", () => {
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "cd"), false);
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "ls"), false);
	});

	it("rejects npm scoped package names", () => {
		assert.strictEqual(isPathLike({ text: "@scope/pkg.token", quoted: false }, "npm"), false);
		assert.strictEqual(isPathLike({ text: "@scope/token-checker", quoted: false }, "npx"), false);
	});

	it("rejects URLs", () => {
		assert.strictEqual(
			isPathLike({ text: "https://api.example.com/v1/token", quoted: false }, "curl"),
			false,
		);
		assert.strictEqual(
			isPathLike({ text: "http://example.com/file.tar", quoted: false }, "wget"),
			false,
		);
		assert.strictEqual(
			isPathLike({ text: "ftp://files.example.com/data.tar", quoted: false }, "wget"),
			false,
		);
		assert.strictEqual(isPathLike({ text: "s3://bucket/key.file", quoted: false }, "aws"), false);
		assert.strictEqual(isPathLike({ text: "file:///tmp/foo", quoted: false }, "cat"), false);
	});

	it("rejects all tokens after echo command", () => {
		assert.strictEqual(isPathLike({ text: "anything", quoted: true }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "anything", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: ".env", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "echo"), false);
	});

	it("rejects all tokens after printf command", () => {
		assert.strictEqual(isPathLike({ text: "anything", quoted: true }, "printf"), false);
		assert.strictEqual(isPathLike({ text: "anything", quoted: false }, "printf"), false);
	});

	it("rejects option flags", () => {
		assert.strictEqual(isPathLike({ text: "--verbose", quoted: false }, "npm"), false);
		assert.strictEqual(isPathLike({ text: "-rf", quoted: false }, "rm"), false);
	});

	it("rejects shell operators", () => {
		assert.strictEqual(isPathLike({ text: "|", quoted: false }, "cat"), false);
		assert.strictEqual(isPathLike({ text: "&&", quoted: false }, "cat"), false);
		assert.strictEqual(isPathLike({ text: ">", quoted: false }, "cat"), false);
	});

	it("accepts dotfiles with non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: ".env", quoted: false }, "cat"), true);
		assert.strictEqual(isPathLike({ text: "src/file.ts", quoted: false }, "cat"), true);
	});

	it("accepts log/tar files with non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "rg"), true);
		assert.strictEqual(isPathLike({ text: "file.tar", quoted: false }, "tar"), true);
	});

	it("accepts unquoted path-like tokens for grep/rg commands", () => {
		assert.strictEqual(isPathLike({ text: "debug.log", quoted: false }, "rg"), true);
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "grep"), true);
		// Quoted versions are also path-like (quote removal preserves path identity)
		assert.strictEqual(isPathLike({ text: "debug.log", quoted: true }, "rg"), true);
	});

	it("accepts quoted path-like tokens for non-echo commands", () => {
		// Bash quote removal: quoted "cat .env" resolves to same path as unquoted cat .env
		assert.strictEqual(isPathLike({ text: "some.log", quoted: true }, "cat"), true);
		assert.strictEqual(isPathLike({ text: ".env", quoted: true }, "cat"), true);
		assert.strictEqual(isPathLike({ text: "secret.txt", quoted: true }, "rg"), true);
		assert.strictEqual(isPathLike({ text: "token.file", quoted: true }, "tar"), true);
	});

	it("rejects tokens containing backtick characters", () => {
		// Backtick content is command substitution, not a file path
		assert.strictEqual(isPathLike({ text: "`some.command`", quoted: false }, "gh"), false);
		assert.strictEqual(
			isPathLike({ text: "text `with.backtick` inside", quoted: true }, "gh"),
			false,
		);
		// Unquoted token without backtick IS path-like (normal case)
		assert.strictEqual(isPathLike({ text: "some.command", quoted: false }, "gh"), true);
	});

	it("accepts quoted dotfiles as path-like for non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: ".env", quoted: true }, "cat"), true);
	});

	it("accepts quoted paths with slash for non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: "src/main.ts", quoted: true }, "git"), true);
	});

	it("accepts quoted relative paths for non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: "../.env", quoted: true }, "cat"), true);
	});

	it("accepts quoted absolute paths for non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: "/absolute/path.env", quoted: true }, "ls"), true);
	});

	it("rejects quoted path-like tokens after echo command (echo guard overrides)", () => {
		assert.strictEqual(isPathLike({ text: "file.tar", quoted: true }, "echo"), false);
	});
});

describe("getCommandName", () => {
	it("extracts first non-option token", () => {
		assert.strictEqual(getCommandName("rg pattern some.log"), "rg");
		assert.strictEqual(getCommandName("npm view @scope/pkg.token"), "npm");
		assert.strictEqual(getCommandName("curl https://example.com/file.tar"), "curl");
	});

	it("skips leading option flags", () => {
		assert.strictEqual(getCommandName("ls -la /tmp"), "ls");
	});

	it("skips quoted tokens", () => {
		assert.strictEqual(getCommandName('"command" arg1'), "arg1");
	});
});

describe("segmentTokens", () => {
	it("empty token list returns empty segments", () => {
		assert.deepStrictEqual(segmentTokens([]), [[]]);
	});

	it("single segment with no separators returns one segment with all tokens", () => {
		const tokens = tokenizeBashCommand("echo hello world");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 1);
		assert.strictEqual(segments[0].length, 3);
	});

	it("single && separator splits into two segments", () => {
		const tokens = tokenizeBashCommand("echo x && cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 2); // echo, x
		assert.strictEqual(segments[1].length, 2); // cat, .env
	});

	it("single || separator splits into two segments", () => {
		const tokens = tokenizeBashCommand("echo x || cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 2); // echo, x
		assert.strictEqual(segments[1].length, 2); // cat, .env
	});

	it("single ; separator splits into two segments", () => {
		const tokens = tokenizeBashCommand("echo x; cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 2); // echo, x
		assert.strictEqual(segments[1].length, 2); // cat, .env
	});

	it("single | separator splits into two segments", () => {
		const tokens = tokenizeBashCommand("echo x | cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 2); // echo, x
		assert.strictEqual(segments[1].length, 2); // cat, .env
	});

	it("multiple separators: echo a && printf b; cat .env -> three segments", () => {
		const tokens = tokenizeBashCommand("echo a && printf b; cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 3);
		assert.strictEqual(segments[0].length, 2); // echo, a
		assert.strictEqual(segments[1].length, 2); // printf, b
		assert.strictEqual(segments[2].length, 2); // cat, .env
	});

	it("consecutive separators (&& &&) produces empty segment between", () => {
		const tokens = tokenizeBashCommand("echo a && && cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 3);
		assert.strictEqual(segments[0].length, 2); // echo, a
		assert.strictEqual(segments[1].length, 0); // empty between && and &&
		assert.strictEqual(segments[2].length, 2); // cat, .env
	});

	it("leading separator (&& cat .env) produces empty segment at start", () => {
		const tokens = tokenizeBashCommand("&& cat .env");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 0); // empty leading segment
		assert.strictEqual(segments[1].length, 2); // cat, .env
	});

	it("trailing separator (cat .env &&) produces empty segment at end", () => {
		const tokens = tokenizeBashCommand("cat .env &&");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 2);
		assert.strictEqual(segments[0].length, 2); // cat, .env
		assert.strictEqual(segments[1].length, 0); // empty trailing segment
	});

	it("quoted separator inside quotes is NOT a segment boundary", () => {
		const tokens = tokenizeBashCommand("echo '&&'");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 1);
		assert.strictEqual(segments[0].length, 2); // echo, '&&'
		assert.strictEqual(segments[0][1].text, "&&");
		assert.strictEqual(segments[0][1].quoted, true);
	});

	it("only separators, no commands (&& ||) produces all empty segments", () => {
		const tokens = tokenizeBashCommand("&& ||");
		const segments = segmentTokens(tokens);
		assert.strictEqual(segments.length, 3);
		assert.strictEqual(segments[0].length, 0);
		assert.strictEqual(segments[1].length, 0);
		assert.strictEqual(segments[2].length, 0);
	});
});

describe("checkBashCommand - segment-scoped echo/printf exclusion", () => {
	const cwd = "/tmp";

	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("echo x && cat .env — blocked (cat segment checked independently)", () => {
		assert.strictEqual(checkBashCommand("echo x && cat .env", entries, cwd), ".env");
	});

	it("echo x; cat .env — blocked", () => {
		assert.strictEqual(checkBashCommand("echo x; cat .env", entries, cwd), ".env");
	});

	it("echo x || cat .env — blocked", () => {
		assert.strictEqual(checkBashCommand("echo x || cat .env", entries, cwd), ".env");
	});

	it("echo x | cat .env — blocked (pipe is a separator)", () => {
		assert.strictEqual(checkBashCommand("echo x | cat .env", entries, cwd), ".env");
	});

	it("printf '%s' 'x' && cat .env — blocked", () => {
		assert.strictEqual(checkBashCommand("printf '%s' 'x' && cat .env", entries, cwd), ".env");
	});

	it("echo hello && echo world — not blocked (both echo)", () => {
		assert.strictEqual(checkBashCommand("echo hello && echo world", entries, cwd), null);
	});

	it("echo hello && cat public.txt — not blocked (no pattern for public.txt)", () => {
		assert.strictEqual(checkBashCommand("echo hello && cat public.txt", entries, cwd), null);
	});

	it("echo .env (single segment) — not blocked (echo exclusion preserved)", () => {
		assert.strictEqual(checkBashCommand("echo .env", entries, cwd), null);
	});

	it("printf '%s' 'hello' (single segment) — not blocked (printf exclusion preserved)", () => {
		assert.strictEqual(checkBashCommand("printf '%s' 'hello'", entries, cwd), null);
	});

	it("echo ~/file.txt (single segment) — not blocked (existing behavior preserved)", () => {
		assert.strictEqual(checkBashCommand("echo ~/file.txt", entries, cwd), null);
	});

	it('echo "file.tar" (single segment, quoted) — not blocked', () => {
		assert.strictEqual(checkBashCommand('echo "file.tar"', entries, cwd), null);
	});

	it("echo file.tar && cat .env.local — blocked (.env.local in cat segment)", () => {
		assert.strictEqual(
			checkBashCommand("echo file.tar && cat .env.local", entries, cwd),
			".env.local",
		);
	});

	it("bash echo x && cat .env && echo y — blocked (middle segment is cat)", () => {
		assert.strictEqual(checkBashCommand("echo x && cat .env && echo y", entries, cwd), ".env");
	});

	it("cat .env (no echo prefix) — blocked (existing behavior preserved)", () => {
		assert.strictEqual(checkBashCommand("cat .env", entries, cwd), ".env");
	});

	it("echo x | cat .env — pipe IS a separator, blocked", () => {
		assert.strictEqual(checkBashCommand("echo x | cat .env", entries, cwd), ".env");
	});

	it("echo x > .env — redirection > not a separator, .env in echo's segment — not blocked (acceptable trade-off)", () => {
		// > is redirection, not a command separator; .env is in echo's segment
		assert.strictEqual(checkBashCommand("echo x > .env", entries, cwd), null);
	});
});

describe("checkBashCommand - false-positive regression with separators", () => {
	const cwd = "/tmp";

	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("echo x && curl https://api.example.com/v1/token — not blocked (URL in curl segment)", () => {
		assert.strictEqual(
			checkBashCommand("echo x && curl https://api.example.com/v1/token", entries, cwd),
			null,
		);
	});

	it("echo x && npm view @scope/pkg.token — not blocked (scoped package in npm segment)", () => {
		assert.strictEqual(checkBashCommand("echo x && npm view @scope/pkg.token", entries, cwd), null);
	});

	it("echo x && cd ~ — not blocked (tilde in cd segment)", () => {
		assert.strictEqual(checkBashCommand("echo x && cd ~", entries, cwd), null);
	});

	it("echo x && ls -la — not blocked (option flag in ls segment)", () => {
		assert.strictEqual(checkBashCommand("echo x && ls -la", entries, cwd), null);
	});

	it("gh issue comment --body with quoted path && echo done — not blocked (quoted body in gh segment)", () => {
		assert.strictEqual(
			checkBashCommand(
				"gh issue comment 123 --repo owner/repo --body 'see src/main.ts' && echo done",
				entries,
				cwd,
			),
			null,
		);
	});

	it("echo x && rg 'pattern' debug.log with *.log pattern — blocked (true positive)", () => {
		assert.strictEqual(
			checkBashCommand('echo x && rg "pattern" debug.log', entries, cwd),
			"debug.log",
		);
	});
});

describe("checkBashCommand false-positive regression", () => {
	const cwd = "/tmp";

	// Minimal .piignore patterns reproducing the false positives
	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("cd ~ — tilde exclusion", () => {
		assert.strictEqual(checkBashCommand("cd ~", entries, cwd), null);
	});

	it("echo ~ — echo command exclusion", () => {
		assert.strictEqual(checkBashCommand("echo ~", entries, cwd), null);
	});

	it("ls ~ — tilde exclusion", () => {
		assert.strictEqual(checkBashCommand("ls ~", entries, cwd), null);
	});

	it("npm view @scope/pkg.token — scoped package exclusion", () => {
		assert.strictEqual(checkBashCommand("npm view @scope/pkg.token", entries, cwd), null);
	});

	it("npx @scope/token-checker — scoped package exclusion", () => {
		assert.strictEqual(checkBashCommand("npx @scope/token-checker", entries, cwd), null);
	});

	it("curl URL with token — URL exclusion", () => {
		assert.strictEqual(
			checkBashCommand("curl https://api.example.com/v1/token", entries, cwd),
			null,
		);
	});

	it("curl URL with .key — URL exclusion", () => {
		assert.strictEqual(checkBashCommand("curl https://example.com/secret.key", entries, cwd), null);
	});

	it("wget URL with .tar — URL exclusion", () => {
		assert.strictEqual(checkBashCommand("wget http://example.com/file.tar", entries, cwd), null);
	});

	it('echo "some.log" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "some.log"', entries, cwd), null);
	});

	it('echo "file.tar" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "file.tar"', entries, cwd), null);
	});

	it('echo "file.token" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "file.token"', entries, cwd), null);
	});

	// ── Regression: gh issue comment with backtick content ────────────

	it("gh issue comment --body with backtick content — not blocked", () => {
		// Single-quoted body with backtick code reference: quoted token → skipped
		assert.strictEqual(
			checkBashCommand(
				"gh issue comment 123 --repo owner/repo --body 'see \`src/main.ts\` for details'",
				entries,
				cwd,
			),
			null,
		);
	});

	it('gh issue comment --body containing "secret" or "token" — not blocked', () => {
		// Body text containing common words "secret" or "token" should NOT
		// be treated as a file path. Quoted token → skipped.
		assert.strictEqual(
			checkBashCommand(
				"gh issue comment 123 --repo owner/repo --body 'the secret is stored in vault'",
				entries,
				cwd,
			),
			null,
		);
		assert.strictEqual(
			checkBashCommand(
				"gh issue comment 123 --repo owner/repo --body 'auth token expired'",
				entries,
				cwd,
			),
			null,
		);
	});

	it("gh issue comment --body with path-like text quoted — not blocked", () => {
		// Body containing "src/main.ts" type references in quotes.
		// Quoted token now path-checked but no pattern match ("see src/main.ts for details"
		// is path-like but doesn't match any .piignore pattern).
		assert.strictEqual(
			checkBashCommand(
				'gh issue comment 123 --repo owner/repo --body "see src/main.ts for details"',
				entries,
				cwd,
			),
			null,
		);
	});
});

describe("checkBashCommand true-positive retention", () => {
	const cwd = "/tmp";

	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("cat .env — blocked (dotfile)", () => {
		assert.strictEqual(checkBashCommand("cat .env", entries, cwd), ".env");
	});

	it("cat .env.local — blocked (.env.* pattern)", () => {
		assert.strictEqual(checkBashCommand("cat .env.local", entries, cwd), ".env.local");
	});

	it('rg "pattern" some.log — blocked (unquoted some.log)', () => {
		assert.strictEqual(checkBashCommand('rg "pattern" some.log', entries, cwd), "some.log");
	});

	it('rg "pattern" debug.log — blocked (unquoted debug.log)', () => {
		assert.strictEqual(checkBashCommand('rg "pattern" debug.log', entries, cwd), "debug.log");
	});

	it("cat .env.production — blocked (.env.* pattern)", () => {
		assert.strictEqual(checkBashCommand("cat .env.production", entries, cwd), ".env.production");
	});

	it("echo ~/file.txt — echo command skips all (acceptable trade-off)", () => {
		// echo is an echo-like command; all tokens are skipped
		assert.strictEqual(checkBashCommand("echo ~/file.txt", entries, cwd), null);
	});

	// ── Phase 4: quoted paths now blocked (fix verification) ─────────

	it('cat ".env" — blocked (quoted dotfile)', () => {
		assert.strictEqual(checkBashCommand('cat ".env"', entries, cwd), ".env");
	});

	it('cat ".env.local" — blocked (quoted .env.* pattern)', () => {
		assert.strictEqual(checkBashCommand('cat ".env.local"', entries, cwd), ".env.local");
	});

	it('rg "pattern" "debug.log" — blocked (both quoted)', () => {
		assert.strictEqual(checkBashCommand('rg "pattern" "debug.log"', entries, cwd), "debug.log");
	});

	it('cat "../.env" — blocked (quoted relative path)', () => {
		assert.strictEqual(checkBashCommand('cat "../.env"', entries, cwd), "../.env");
	});
});
