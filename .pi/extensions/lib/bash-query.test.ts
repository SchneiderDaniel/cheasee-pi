/**
 * Tests for bash-query.ts — pure bash command detection functions.
 *
 * Layer: entity — pure function tests, no I/O, no mocking.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/bash-query.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBashSearch, isBashFileRead, isBashFileModify, isBashSearchOrRead } from "./bash-query.ts";

// ═══════════════════════════════════════════════════════════════════════
// isBashSearch
// ═══════════════════════════════════════════════════════════════════════

describe("isBashSearch", () => {
	it("standalone grep → true", () => {
		assert.strictEqual(isBashSearch("grep foo"), true);
	});

	it("standalone rg → true", () => {
		assert.strictEqual(isBashSearch("rg pattern"), true);
	});

	it("backtick grep → true", () => {
		assert.strictEqual(isBashSearch("`grep foo`"), true);
	});

	it("backtick rg → true", () => {
		assert.strictEqual(isBashSearch("`rg`"), true);
	});

	it("piped file→grep: cat file | grep foo → true (subsumes isPipedFileGrep)", () => {
		assert.strictEqual(isBashSearch("cat file | grep foo"), true);
	});

	it("piped file→rg: head -n 5 file | rg pattern → true", () => {
		assert.strictEqual(isBashSearch("head -n 5 file | rg pattern"), true);
	});

	it("piped file→rg: cat file | rg foo → true", () => {
		assert.strictEqual(isBashSearch("cat file | rg foo"), true);
	});

	it("non-file pipe: ls | grep foo → false", () => {
		assert.strictEqual(isBashSearch("ls | grep foo"), false);
	});

	it("&& chained: cd src && rg foo → false", () => {
		assert.strictEqual(isBashSearch("cd src && rg foo"), false);
	});

	it("semicolon chained: echo hi; grep foo → false", () => {
		assert.strictEqual(isBashSearch("echo hi; grep foo"), false);
	});

	it("grep with redirect → true (matches BashCommand.isSearch behavior)", () => {
		assert.strictEqual(isBashSearch("grep foo > out.txt"), true);
	});

	it("grep in quoted arg, not first token → false", () => {
		assert.strictEqual(isBashSearch("gh issue create --body 'uses grep'"), false);
	});

	it("find → false (excluded; handled by isBashSearchOrRead)", () => {
		assert.strictEqual(isBashSearch("find . -name '*.ts'"), false);
	});

	it("empty string → false", () => {
		assert.strictEqual(isBashSearch(""), false);
	});

	it("grep not first token → false", () => {
		assert.strictEqual(isBashSearch("npm grep foo"), false);
	});

	it("tail | grep → true (piped file→grep)", () => {
		assert.strictEqual(isBashSearch("tail -f log | grep error"), true);
	});

	it("less | grep → true (piped file→grep)", () => {
		assert.strictEqual(isBashSearch("less file | grep foo"), true);
	});

	it("more | grep → true (piped file→grep)", () => {
		assert.strictEqual(isBashSearch("more file | grep foo"), true);
	});

	// ── Bug fix: pipe grep/rg with variant spacing ──

	it("piped file→grep: cat file |  grep foo (two spaces after pipe) → true", () => {
		assert.strictEqual(isBashSearch("cat file |  grep foo"), true);
	});

	it("piped file→grep: cat file |grep foo (no space after pipe) → true", () => {
		assert.strictEqual(isBashSearch("cat file |grep foo"), true);
	});

	it("piped file→rg: cat file |  rg foo (two spaces after pipe) → true", () => {
		assert.strictEqual(isBashSearch("cat file |  rg foo"), true);
	});

	it("piped file→rg: cat file |rg foo (no space after pipe) → true", () => {
		assert.strictEqual(isBashSearch("cat file |rg foo"), true);
	});

	it("pipe grep word boundary: cat file | grepped → false (prefix match)", () => {
		assert.strictEqual(isBashSearch("cat file | grepped"), false);
	});

	it("pipe rg word boundary: cat file | rgfoo → false (prefix match)", () => {
		assert.strictEqual(isBashSearch("cat file | rgfoo"), false);
	});

	it("command-output pipe: git branch | grep feature → false", () => {
		assert.strictEqual(isBashSearch("git branch -a | grep feature"), false);
	});

	it("ls | grep -v node_modules → false", () => {
		assert.strictEqual(isBashSearch("ls | grep -v node_modules"), false);
	});

	it("backtick rg in the middle of string arg → false", () => {
		assert.strictEqual(isBashSearch("echo '`rg`'"), false);
	});

	it("grep with arguments but no redirect → true", () => {
		assert.strictEqual(isBashSearch("grep -r 'foo' src/"), true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isBashFileRead
// ═══════════════════════════════════════════════════════════════════════

describe("isBashFileRead", () => {
	it("cat file.ts → true", () => {
		assert.strictEqual(isBashFileRead("cat file.ts"), true);
	});

	it("head -5 file.ts → true", () => {
		assert.strictEqual(isBashFileRead("head -5 file.ts"), true);
	});

	it("tail -10 file.ts → true", () => {
		assert.strictEqual(isBashFileRead("tail -10 file.ts"), true);
	});

	it("less file.ts → true", () => {
		assert.strictEqual(isBashFileRead("less file.ts"), true);
	});

	it("more file.ts → true", () => {
		assert.strictEqual(isBashFileRead("more file.ts"), true);
	});

	it("cat with write redirect → false", () => {
		assert.strictEqual(isBashFileRead("cat > /tmp/foo"), false);
	});

	it("cat with append redirect → false", () => {
		assert.strictEqual(isBashFileRead("cat >> file"), false);
	});

	it("read cmd in pipe, not first → false", () => {
		assert.strictEqual(isBashFileRead("ls -la | head -5"), false);
	});

	it("empty string → false", () => {
		assert.strictEqual(isBashFileRead(""), false);
	});

	it("cat file with arguments → true", () => {
		assert.strictEqual(isBashFileRead("cat -n file.ts"), true);
	});

	it("head with redirect → false", () => {
		assert.strictEqual(isBashFileRead("head -5 file.ts > out.txt"), false);
	});

	it("piped read: cat file | grep foo → true (first segment is read)", () => {
		assert.strictEqual(isBashFileRead("cat file | grep foo"), true);
	});

	it('cat without arguments → true (token is "cat")', () => {
		assert.strictEqual(isBashFileRead("cat"), true);
	});

	it("just spaces → false", () => {
		assert.strictEqual(isBashFileRead("   "), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isBashFileModify
// ═══════════════════════════════════════════════════════════════════════

describe("isBashFileModify", () => {
	it("echo with write redirect > → true", () => {
		assert.strictEqual(isBashFileModify("echo hi > file"), true);
	});

	it("echo with append redirect >> → true", () => {
		assert.strictEqual(isBashFileModify("echo hi >> file"), true);
	});

	it("sed command → true", () => {
		assert.strictEqual(isBashFileModify("sed -i 's/foo/bar/g' file.ts"), true);
	});

	it("tee command → true", () => {
		assert.strictEqual(isBashFileModify("tee f.ts"), true);
	});

	it("mv command → true", () => {
		assert.strictEqual(isBashFileModify("mv old.ts new.ts"), true);
	});

	it("cp command → true", () => {
		assert.strictEqual(isBashFileModify("cp a.ts b.ts"), true);
	});

	it("rm command → true", () => {
		assert.strictEqual(isBashFileModify("rm file.ts"), true);
	});

	it("chmod command → true", () => {
		assert.strictEqual(isBashFileModify("chmod +x script.sh"), true);
	});

	it("dd command → true", () => {
		assert.strictEqual(isBashFileModify("dd if=/dev/zero of=file bs=1M count=1"), true);
	});

	it("known modify command with arguments → true", () => {
		assert.strictEqual(isBashFileModify("sed -i 's/foo/bar/g' file"), true);
	});

	it("non-modifying command (ls) → false", () => {
		assert.strictEqual(isBashFileModify("ls -la"), false);
	});

	it("non-modifying command (cat) → false", () => {
		assert.strictEqual(isBashFileModify("cat file.ts"), false);
	});

	it("non-modifying command (echo) → false", () => {
		assert.strictEqual(isBashFileModify("echo hello"), false);
	});

	it("non-modifying command (grep) → false", () => {
		assert.strictEqual(isBashFileModify("grep foo"), false);
	});

	it("non-modifying command (find) → false", () => {
		assert.strictEqual(isBashFileModify("find . -name '*.ts'"), false);
	});

	it("piped read command no redirect → false", () => {
		assert.strictEqual(isBashFileModify("cat file | grep foo"), false);
	});

	it("piped modify command with redirect → true", () => {
		assert.strictEqual(isBashFileModify("sed 's/foo/bar/g' file > out"), true);
	});

	it("piped command where first segment has modify command → true", () => {
		assert.strictEqual(isBashFileModify("rm file | echo done"), true);
	});

	it("empty string → false", () => {
		assert.strictEqual(isBashFileModify(""), false);
	});

	it("whitespace-only string → false", () => {
		assert.strictEqual(isBashFileModify("   "), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isBashSearchOrRead
// ═══════════════════════════════════════════════════════════════════════

describe("isBashSearchOrRead", () => {
	it("grep foo → true (search)", () => {
		assert.strictEqual(isBashSearchOrRead("grep foo"), true);
	});

	it("cat file.ts → true (read)", () => {
		assert.strictEqual(isBashSearchOrRead("cat file.ts"), true);
	});

	it('find . -name "*.ts" → true (find included in composite)', () => {
		assert.strictEqual(isBashSearchOrRead("find . -name '*.ts'"), true);
	});

	it("ls | grep foo → false (non-file pipe)", () => {
		assert.strictEqual(isBashSearchOrRead("ls | grep foo"), false);
	});

	it("npm test → false (no search/read/find)", () => {
		assert.strictEqual(isBashSearchOrRead("npm test"), false);
	});

	it("empty string → false", () => {
		assert.strictEqual(isBashSearchOrRead(""), false);
	});

	it("cd src && find . → false (&& chained find)", () => {
		assert.strictEqual(isBashSearchOrRead("cd src && find ."), false);
	});

	it("rg pattern → true (search)", () => {
		assert.strictEqual(isBashSearchOrRead("rg pattern"), true);
	});

	it("piped file→grep: cat file | grep foo → true", () => {
		assert.strictEqual(isBashSearchOrRead("cat file | grep foo"), true);
	});

	it("piped file→grep variant spacing: cat file |  grep foo → true (cross-check)", () => {
		assert.strictEqual(isBashSearchOrRead("cat file |  grep foo"), true);
	});

	it("tail -f log | grep error → true (piped read→grep)", () => {
		assert.strictEqual(isBashSearchOrRead("tail -f log | grep error"), true);
	});

	it("head -5 file.ts → true (read)", () => {
		assert.strictEqual(isBashSearchOrRead("head -5 file.ts"), true);
	});

	it("less file.ts → true (read)", () => {
		assert.strictEqual(isBashSearchOrRead("less file.ts"), true);
	});

	it("more file.ts → true (read)", () => {
		assert.strictEqual(isBashSearchOrRead("more file.ts"), true);
	});

	it("backtick grep → true", () => {
		assert.strictEqual(isBashSearchOrRead("`grep foo`"), true);
	});

	it("cat with redirect → false (write, not read)", () => {
		assert.strictEqual(isBashSearchOrRead("cat > /tmp/foo"), false);
	});
});
