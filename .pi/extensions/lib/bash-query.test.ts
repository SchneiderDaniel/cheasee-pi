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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBashSearch, isBashFileRead, isBashFileModify } from "./bash-query.ts";

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

	it("piped file→rg: head -n 5 file | rg pattern → false (head no longer in READ_CMDS)", () => {
		assert.strictEqual(isBashSearch("head -n 5 file | rg pattern"), false);
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

	it("find → false (not a search, stays pass-through)", () => {
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

	it("head -5 file.ts → false (head no longer in READ_CMDS)", () => {
		assert.strictEqual(isBashFileRead("head -5 file.ts"), false);
	});

	it("tail -10 file.ts → false (tail is not a read redirect — O(N) from EOF, read tool is O(file size))", () => {
		assert.strictEqual(isBashFileRead("tail -10 file.ts"), false);
	});

	it("tail -f log → false (streaming follow, not a read)", () => {
		assert.strictEqual(isBashFileRead("tail -f log"), false);
	});

	it("tail -n +1 file → false (full-file variant still not redirectable)", () => {
		assert.strictEqual(isBashFileRead("tail -n +1 file"), false);
	});

	it("tail -c 5 file → false (byte-count tail not redirectable)", () => {
		assert.strictEqual(isBashFileRead("tail -c 5 file"), false);
	});

	it("tail -f log | grep error → false (first segment tail, not a file-read redirect)", () => {
		assert.strictEqual(isBashFileRead("tail -f log | grep error"), false);
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
// dead code removal — isBashSearchOrRead
// ═══════════════════════════════════════════════════════════════════════

describe("dead code removal — isBashSearchOrRead", () => {
	const bashQueryPath = resolve(import.meta.dirname, "./bash-query.ts");
	const testPath = resolve(import.meta.dirname, "./bash-query.test.ts");
	const harnessPath = resolve(import.meta.dirname, "../agent-harness/agent-harness.ts");

	it("bash-query.ts no longer exports isBashSearchOrRead", () => {
		const content = readFileSync(bashQueryPath, "utf-8");
		assert.ok(
			!content.includes("isBashSearchOrRead"),
			"Expected isBashSearchOrRead (function + JSDoc) to be removed from bash-query.ts",
		);
	});

	it("bash-query.ts no longer claims a detectTurnInefficiency consumer", () => {
		const content = readFileSync(bashQueryPath, "utf-8");
		assert.ok(
			!content.includes("detectTurnInefficiency"),
			"Expected false detectTurnInefficiency consumer claim to be purged",
		);
	});

	it("bash-query.ts module header no longer lists isBashSearchOrRead as subsumed path", () => {
		const content = readFileSync(bashQueryPath, "utf-8");
		assert.ok(
			!content.includes("isBashSearchOrRead() — turn-inefficiency classification"),
			"Expected subsumed-path bullet #3 to be dropped from module docstring",
		);
	});

	it("isBashSearch JSDoc no longer defers find to isBashSearchOrRead", () => {
		const content = readFileSync(bashQueryPath, "utf-8");
		assert.ok(
			!content.includes("handled by isBashSearchOrRead"),
			"Expected dangling 'handled by isBashSearchOrRead' JSDoc note to be reworded",
		);
	});

	it("bash-query.test.ts no longer references isBashSearchOrRead (import, find-test comment, describe block)", () => {
		const content = readFileSync(testPath, "utf-8");
		// This verification block's own title/strings mention the token, so a
		// whole-file token check would match itself. Check only the portion of
		// the file preceding the verification banner — the import line, the stale
		// find-test comment, and the old describe block all lived there.
		const preVerification = content.slice(0, content.indexOf("// dead code removal"));
		assert.ok(
			!preVerification.includes("isBashSearchOrRead"),
			"Expected import, stale find-test comment, and old describe block to be removed",
		);
	});

	it("agent-harness.ts never references isBashSearchOrRead (no wiring alternative)", () => {
		const content = readFileSync(harnessPath, "utf-8");
		assert.ok(
			!content.includes("isBashSearchOrRead"),
			"Expected no isBashSearchOrRead reference in agent-harness.ts",
		);
	});

	it("bash-query.test.ts still imports the surviving exports", () => {
		const content = readFileSync(testPath, "utf-8");
		assert.ok(
			content.includes("isBashSearch, isBashFileRead, isBashFileModify"),
			"Expected import line to still reference isBashSearch, isBashFileRead, isBashFileModify",
		);
	});
});
