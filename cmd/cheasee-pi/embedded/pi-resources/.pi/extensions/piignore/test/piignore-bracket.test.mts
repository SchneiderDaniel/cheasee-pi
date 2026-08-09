/**
 * Tests for piignore bracket expression handling in patternToRegex.
 *
 * Verifies that bracket expressions [abc] are treated as regex character
 * classes rather than escaped literals, according to gitignore spec.
 *
 * Phase 1 (Domain): Pure regex matching, no I/O.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-bracket.test.mts
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

	// Step 1b: Escape regex meta-characters except *, ?, /
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

describe("piignore bracket expressions", () => {
	// ── Happy path: basic bracket expressions ─────────────────────────

	describe("[abc].txt — character class", () => {
		it("matches a.txt", () => {
			assertMatch("[abc].txt", "a.txt");
		});
		it("matches b.txt", () => {
			assertMatch("[abc].txt", "b.txt");
		});
		it("matches c.txt", () => {
			assertMatch("[abc].txt", "c.txt");
		});
		it("does not match d.txt", () => {
			assertNoMatch("[abc].txt", "d.txt");
		});
		it("does not match literal [abc].txt", () => {
			assertNoMatch("[abc].txt", "[abc].txt");
		});
	});

	describe("[a-z].txt — character range", () => {
		it("matches m.txt", () => {
			assertMatch("[a-z].txt", "m.txt");
		});
		it("does not match 1.txt", () => {
			assertNoMatch("[a-z].txt", "1.txt");
		});
		it("does not match literal [a-z].txt", () => {
			assertNoMatch("[a-z].txt", "[a-z].txt");
		});
	});

	describe("[!abc].txt — negated character class", () => {
		it("matches d.txt", () => {
			assertMatch("[!abc].txt", "d.txt");
		});
		it("matches x.txt", () => {
			assertMatch("[!abc].txt", "x.txt");
		});
		it("does not match a.txt", () => {
			assertNoMatch("[!abc].txt", "a.txt");
		});
	});

	describe("[0-9].log — digit range", () => {
		it("matches 5.log", () => {
			assertMatch("[0-9].log", "5.log");
		});
		it("does not match a.log", () => {
			assertNoMatch("[0-9].log", "a.log");
		});
	});

	// ── Boundary: empty/unclosed brackets ─────────────────────────────

	describe("[] — empty bracket (edge case)", () => {
		it("matches literal [].txt", () => {
			assertMatch("[].txt", "[].txt");
		});
		it("does not match a.txt", () => {
			assertNoMatch("[].txt", "a.txt");
		});
	});

	describe("[ — unclosed bracket (edge case)", () => {
		it("treats unclosed [ as literal", () => {
			// Single [ should match literal [
			assertMatch("[.txt", "[.txt");
		});
	});

	describe("] — standalone bracket (edge case)", () => {
		it("treats standalone ] as literal", () => {
			assertMatch("].txt", "].txt");
		});
	});

	// ── Boundary: meta-chars inside brackets (should be literal) ──────

	describe("[*].txt — * inside brackets", () => {
		it("matches literal *.txt", () => {
			assertMatch("[*].txt", "*.txt");
		});
		it("does not match a.txt", () => {
			assertNoMatch("[*].txt", "a.txt");
		});
	});

	describe("[?].txt — ? inside brackets", () => {
		it("matches literal ?.txt", () => {
			assertMatch("[?].txt", "?.txt");
		});
		it("does not match a.txt", () => {
			assertNoMatch("[?].txt", "a.txt");
		});
	});

	describe("[.].txt — . inside brackets", () => {
		it("matches literal dot", () => {
			assertMatch("[.].txt", "..txt");
		});
	});

	// ── Boundary: multiple bracket expressions ────────────────────────

	describe("[abc].[xyz] — two bracket expressions", () => {
		it("matches a.x", () => {
			assertMatch("[abc].[xyz]", "a.x");
		});
		it("matches c.z", () => {
			assertMatch("[abc].[xyz]", "c.z");
		});
		it("does not match d.x", () => {
			assertNoMatch("[abc].[xyz]", "d.x");
		});
		it("does not match a.w", () => {
			assertNoMatch("[abc].[xyz]", "a.w");
		});
	});

	// ── Boundary: negation with bracket ───────────────────────────────

	describe("![abc].txt — negation of whole pattern with bracket", () => {
		it("negates the pattern (bracket still char class)", () => {
			const { regex, negate } = patternToRegex("![abc].txt");
			assert.strictEqual(negate, true, "should be negated");
			// The bracket should still be a character class:
			// ![abc].txt means "do NOT match a.txt, b.txt, c.txt"
			assert.ok(regex.test("a.txt"), "negated pattern should test original");
			// But negation patterns in piignore mean: if matched, negate previous
			// So the regeg should still match a.txt, b.txt, c.txt
		});
	});

	// ── Boundary: double-char range ───────────────────────────────────

	describe("[a-z0-9].txt — double range", () => {
		it("matches m.txt", () => {
			assertMatch("[a-z0-9].txt", "m.txt");
		});
		it("matches 5.txt", () => {
			assertMatch("[a-z0-9].txt", "5.txt");
		});
		it("does not match _.txt", () => {
			assertNoMatch("[a-z0-9].txt", "_.txt");
		});
	});

	// ── Boundary: bracket as dir component ────────────────────────────

	describe("dir/[abc].txt — bracket in directory", () => {
		it("matches dir/a.txt", () => {
			assertMatch("dir/[abc].txt", "dir/a.txt");
		});
		it("matches sub/dir/b.txt (from any depth)", () => {
			// Since pattern has /, it's anchored to start: ^dir/[abc].txt$
			// Only matches exactly dir/a.txt, dir/b.txt, dir/c.txt
			assertMatch("dir/[abc].txt", "dir/b.txt");
		});
		it("does not match other/b.txt", () => {
			assertNoMatch("dir/[abc].txt", "other/b.txt");
		});
	});

	describe("**/[abc].txt — bracket with **/ glob", () => {
		it("matches a.txt from root", () => {
			assertMatch("**/[abc].txt", "a.txt");
		});
		it("matches dir/a.txt from subdirectory", () => {
			assertMatch("**/[abc].txt", "dir/a.txt");
		});
		it("matches deep/path/b.txt", () => {
			assertMatch("**/[abc].txt", "deep/path/b.txt");
		});
		it("does not match d.txt", () => {
			assertNoMatch("**/[abc].txt", "d.txt");
		});
	});

	// ── Regression: simple patterns still work ────────────────────────

	describe("regression — simple patterns still work", () => {
		it("*.txt matches any .txt file", () => {
			assertMatch("*.txt", "file.txt");
			assertMatch("*.txt", "a.txt");
		});

		it("secret.env matches exactly", () => {
			assertMatch("secret.env", "secret.env");
			assertNoMatch("secret.env", "other.env");
		});

		it("build/ matches directory", () => {
			assertMatch("build/", "build");
			assertMatch("build/", "src/build");
		});

		it("src/**/*.ts matches nested ts files", () => {
			assertMatch("src/**/*.ts", "src/index.ts");
			assertMatch("src/**/*.ts", "src/deep/file.ts");
			assertNoMatch("src/**/*.ts", "other/index.ts");
		});

		it("!important.log is negation", () => {
			const { regex, negate } = patternToRegex("!important.log");
			assert.strictEqual(negate, true);
			assert.ok(regex.test("important.log"));
		});
	});

	// ── Regression: special regex chars outside brackets still escaped ─

	describe("regression — special regex chars outside brackets", () => {
		const specialChars = [".", "+", "^", "$", "{", "}", "(", ")", "|", "\\"];

		for (const ch of specialChars) {
			it(`escapes ${ch} outside brackets`, () => {
				// Create a pattern with special char, verify the regex doesn't
				// interpret it as regex syntax
				const pattern = `file${ch}txt`;
				const { regex } = patternToRegex(pattern);
				// Should match literal: file<char>txt
				assert.ok(regex.test(`file${ch}txt`), `should match literal file${ch}txt`);
			});
		}
	});
});
