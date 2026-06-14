/**
 * Tests for piignore patternToRegex escape sequence handling.
 *
 * Verifies that leading escape sequences in gitignore patterns are
 * handled correctly per spec:
 *   \# → literal # (not comment)
 *   \! → literal ! (not negation)
 *   \\ → literal \  (single backslash)
 *
 * Phase 1 (Domain): Pure regex matching, no I/O.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-escape.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/piignore.ts)
// ═══════════════════════════════════════════════════════════════════════

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Inline patternToRegex — inline copy of the source function so tests
// define the contract. Update when source is fixed.
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

	// Step 1a: Extract and preserve bracket expressions so the regex
	//          escape step doesn't mangle [ and ].
	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	// Step 1b: Escape regex meta-characters except *, ?, [, ]
	r = r.replace(/[.+^${}()|\\]/g, "\\$&");

	// Step 1c: Escape unclosed [ (bracket without matching ]) as literal
	r = r.replace(/\[/g, "\\[");

	// Step 2: Replace **/ and ** with placeholders
	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");

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

// ═══════════════════════════════════════════════════════════════════════
// Helper: test that a pattern matches or doesn't match paths
// ═══════════════════════════════════════════════════════════════════════

function assertMatch(pattern: string, path: string, msg?: string): void {
	const { regex } = patternToRegex(pattern);
	assert.ok(regex.test(path), msg ?? `"${pattern}" should match "${path}"`);
}

function assertNoMatch(pattern: string, path: string, msg?: string): void {
	const { regex } = patternToRegex(pattern);
	assert.ok(!regex.test(path), msg ?? `"${pattern}" should NOT match "${path}"`);
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("piignore escape sequences", () => {
	// ── Entity: \# escapes hash ─────────────────────────────────────

	describe("\\#foo — escaped hash pattern", () => {
		it("matches #foo (backslash stripped, hash literal)", () => {
			assertMatch("\\#foo", "#foo");
		});

		it("does NOT match \\#foo (backslash consumed)", () => {
			assertNoMatch("\\#foo", "\\#foo");
		});

		it("returns negate=false (not a comment)", () => {
			const { negate } = patternToRegex("\\#foo");
			assert.strictEqual(negate, false);
		});
	});

	// ── Entity: \! escapes exclamation ──────────────────────────────

	describe("\\!foo — escaped exclamation pattern", () => {
		it("matches !foo (backslash stripped, exclamation literal)", () => {
			assertMatch("\\!foo", "!foo");
		});

		it("has negate=false (escape prevents negation detection)", () => {
			const { negate } = patternToRegex("\\!foo");
			assert.strictEqual(negate, false, "\\!foo should NOT be negated");
		});

		it("does NOT match \\!foo (backslash consumed)", () => {
			assertNoMatch("\\!foo", "\\!foo");
		});
	});

	// ── Entity: \\ escapes backslash ────────────────────────────────

	describe("\\\\foo — escaped backslash pattern", () => {
		it("matches \\foo (one backslash stripped, one remains)", () => {
			assertMatch("\\\\foo", "\\foo");
		});

		it("does NOT match \\\\foo (one backslash consumed)", () => {
			assertNoMatch("\\\\foo", "\\\\foo");
		});
	});

	// ── Boundary: minimal patterns ──────────────────────────────────

	describe("\\# — minimal escaped hash", () => {
		it("matches #", () => {
			assertMatch("\\#", "#");
		});

		it("has negate=false", () => {
			const { negate } = patternToRegex("\\#");
			assert.strictEqual(negate, false);
		});
	});

	describe("\\! — minimal escaped exclamation", () => {
		it("matches !", () => {
			assertMatch("\\!", "!");
		});

		it("has negate=false", () => {
			const { negate } = patternToRegex("\\!");
			assert.strictEqual(negate, false, "\\! alone should NOT be negated");
		});
	});

	describe("\\\\ — minimal escaped backslash", () => {
		it("matches \\", () => {
			assertMatch("\\\\", "\\");
		});
	});

	// ── Regression: negation still works ────────────────────────────

	describe("!foo — negation still works (regression)", () => {
		it("has negate=true", () => {
			const { negate } = patternToRegex("!foo");
			assert.strictEqual(negate, true, "!foo should be negated");
		});

		it("matches foo", () => {
			assertMatch("!foo", "foo");
		});
	});

	// ── Regression: simple globs unchanged ──────────────────────────

	describe("*.txt — simple glob (regression)", () => {
		it("matches a.txt", () => {
			assertMatch("*.txt", "a.txt");
		});

		it("matches file.txt", () => {
			assertMatch("*.txt", "file.txt");
		});

		it("does not match foo.md", () => {
			assertNoMatch("*.txt", "foo.md");
		});
	});

	// ── Regression: bracket expressions still work ──────────────────

	describe("[abc].txt — bracket (regression after escape code insertion)", () => {
		it("matches b.txt", () => {
			assertMatch("[abc].txt", "b.txt");
		});

		it("does not match d.txt", () => {
			assertNoMatch("[abc].txt", "d.txt");
		});

		it("does not match literal [abc].txt", () => {
			assertNoMatch("[abc].txt", "[abc].txt");
		});
	});

	// ── Regression: hashed comment lines ────────────────────────────

	describe("#foo — comment (regression: parseIgnore skips these)", () => {
		it("produces a pattern (test domain only — parseIgnore filters # lines)", () => {
			// This tests that patternToRegex alone doesn't choke on #
			const { regex, negate } = patternToRegex("#foo");
			assert.strictEqual(negate, false);
			// #foo is handled as a literal pattern by patternToRegex
			// (parseIgnore is the one that skips # lines)
		});
	});
});
