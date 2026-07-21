/**
 * Tests for BashCommand class — pure domain class.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BashCommand } from "./bash-command.ts";

// ── Entity: isSearch (delegation wiring to bash-query) ──

describe("BashCommand.isSearch — delegation to bash-query", () => {
	it("standalone grep → true", () => {
		assert.equal(new BashCommand("grep foo").isSearch(), true);
	});

	it("piped file→grep: cat file | grep foo → true (new via delegation)", () => {
		assert.equal(new BashCommand("cat file | grep foo").isSearch(), true);
	});

	it("non-file pipe: ls | grep foo → false", () => {
		assert.equal(new BashCommand("ls | grep foo").isSearch(), false);
	});

	it("&& chained: cd src && rg foo → false", () => {
		assert.equal(new BashCommand("cd src && rg foo").isSearch(), false);
	});

	it("; chained: echo hi; grep foo → false", () => {
		assert.equal(new BashCommand("echo hi; grep foo").isSearch(), false);
	});

	it("empty → false", () => {
		assert.equal(new BashCommand("").isSearch(), false);
	});

	it("BashCommand.from('grep foo').isSearch() → true", () => {
		assert.equal(BashCommand.from("grep foo").isSearch(), true);
	});
});

// ── Entity: isFileRead (delegation wiring to bash-query) ──

describe("BashCommand.isFileRead — delegation to bash-query", () => {
	it("cat file.ts → true", () => {
		assert.equal(new BashCommand("cat file.ts").isFileRead(), true);
	});

	it("cat > /tmp/foo → false (redirect suppresses)", () => {
		assert.equal(new BashCommand("cat > /tmp/foo").isFileRead(), false);
	});

	it("ls -la | head -5 → false (piped read, not first segment)", () => {
		assert.equal(new BashCommand("ls -la | head -5").isFileRead(), false);
	});

	it("empty → false", () => {
		assert.equal(new BashCommand("").isFileRead(), false);
	});

	it("BashCommand.from('cat file.ts').isFileRead() → true", () => {
		assert.equal(BashCommand.from("cat file.ts").isFileRead(), true);
	});
});

// ── Entity: isFileModify ──

describe("BashCommand.isFileModify", () => {
	it("detects sed -i", () => {
		assert.equal(new BashCommand("sed -i 's/foo/bar/g' file.ts").isFileModify(), true);
	});

	it("detects echo with redirect", () => {
		assert.equal(new BashCommand("echo 'content' > file.ts").isFileModify(), true);
	});

	it("detects cat with redirect", () => {
		assert.equal(new BashCommand("cat > file.ts << EOF").isFileModify(), true);
	});

	it("detects tee command", () => {
		assert.equal(new BashCommand("tee f.ts").isFileModify(), true);
	});

	it("detects mv command", () => {
		assert.equal(new BashCommand("mv old.ts new.ts").isFileModify(), true);
	});

	it("detects cp command", () => {
		assert.equal(new BashCommand("cp a.ts b.ts").isFileModify(), true);
	});

	it("detects rm command", () => {
		assert.equal(new BashCommand("rm file.ts").isFileModify(), true);
	});

	it("detects chmod command", () => {
		assert.equal(new BashCommand("chmod +x script.sh").isFileModify(), true);
	});

	it("detects dd command", () => {
		assert.equal(new BashCommand("dd if=/dev/zero of=file bs=1M count=1").isFileModify(), true);
	});

	// ── Phase 1 characterization: each FILE_MODIFY_SIGNALS value triggers isFileModify ──

	it("sed triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("sed -i 's/foo/bar/g' f.ts").isFileModify(), true);
	});

	it("echo triggers isFileModify (characterization)", () => {
		// echo without redirect is stdout-only; redirect cases caught by > check
		assert.equal(new BashCommand("echo hi").isFileModify(), false);
		assert.equal(new BashCommand("echo hi > f.ts").isFileModify(), true);
	});

	it("cat triggers isFileModify (characterization)", () => {
		// cat without redirect is read-only; redirect cases caught by > check
		assert.equal(new BashCommand("cat > f.ts").isFileModify(), true);
		assert.equal(new BashCommand("cat file.ts").isFileModify(), false);
	});

	it("tee triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("tee f.ts").isFileModify(), true);
	});

	it("mv triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("mv a b").isFileModify(), true);
	});

	it("cp triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("cp a b").isFileModify(), true);
	});

	it("rm triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("rm f.ts").isFileModify(), true);
	});

	it("chmod triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("chmod +x f.sh").isFileModify(), true);
	});

	it("dd triggers isFileModify (characterization)", () => {
		assert.equal(new BashCommand("dd if=/dev/zero of=f bs=1M count=1").isFileModify(), true);
	});

	it("bare cat does not flag isFileModify (regression)", () => {
		assert.equal(new BashCommand("cat file.ts").isFileModify(), false);
	});

	it("bare echo does not flag isFileModify (regression)", () => {
		assert.equal(new BashCommand("echo hello").isFileModify(), false);
	});

	it("does not flag read-only commands", () => {
		assert.equal(new BashCommand("ls -la").isFileModify(), false);
		assert.equal(new BashCommand("git status").isFileModify(), false);
	});

	it("detects bare redirect via any command", () => {
		assert.equal(new BashCommand("echo hi > /tmp/test").isFileModify(), true);
	});

	it("false for empty command", () => {
		assert.equal(new BashCommand("").isFileModify(), false);
	});
});

// ── Behavior: detectMismatch ──

describe("BashCommand.detectMismatch", () => {
	it("standalone grep → ripgrep_search", () => {
		const result = new BashCommand("grep foo bar.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("piped grep → null (pass through)", () => {
		const result = new BashCommand("find . -name '*.ts' | grep foo").detectMismatch();
		assert.equal(result, null);
	});

	it("&& chained grep → null (pass through)", () => {
		const result = new BashCommand("cd src && rg pattern").detectMismatch();
		assert.equal(result, null);
	});

	it("semicolon chained grep → null (pass through)", () => {
		const result = new BashCommand("echo hi; grep foo").detectMismatch();
		assert.equal(result, null);
	});

	it("standalone cat → read", () => {
		const result = new BashCommand("cat file.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("read"));
	});

	it("piped cat → null (pass through)", () => {
		const result = new BashCommand("ps aux | head -5").detectMismatch();
		assert.equal(result, null);
	});

	it("cat with write redirect → null (modify, not read)", () => {
		const result = new BashCommand("cat > /tmp/foo << EOF").detectMismatch();
		assert.equal(result, null);
	});

	it("backtick grep → ripgrep_search", () => {
		const result = new BashCommand("`grep foo`").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("ls → informational mismatch", () => {
		const result = new BashCommand("ls -la").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
	});

	it("cd ... && grep → null (pass through)", () => {
		const result = new BashCommand("cd /tmp && grep foo file.txt").detectMismatch();
		assert.equal(result, null);
	});

	it("cd ... && backtick grep in body → null (pass through)", () => {
		const result = new BashCommand(
			"cd /tmp && gh issue comment --body '`` `grep` ``'",
		).detectMismatch();
		assert.equal(result, null);
	});

	it("cd ... && backtick rg in body → null (pass through)", () => {
		const result = new BashCommand("cd /tmp && echo 'testing `rg` in body'").detectMismatch();
		assert.equal(result, null);
	});

	it("gh issue with cat in quoted arg → null (pass through)", () => {
		const result = new BashCommand(`gh issue view 123 --title "cat file"`).detectMismatch();
		assert.equal(result, null);
	});

	it("normal command → null", () => {
		const result = new BashCommand("echo hi").detectMismatch();
		assert.equal(result, null);
	});

	it("empty command → null", () => {
		const result = new BashCommand("").detectMismatch();
		assert.equal(result, null);
	});

	// ── Phase 1 characterization: each READ_BASH_CMDS value triggers detectMismatch with "read" ──

	it("cat triggers detectMismatch with 'read' suggestion (characterization)", () => {
		const result = new BashCommand("cat file.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.ok(result!.suggestion.includes("read"));
	});

	it("head triggers detectMismatch with 'read' suggestion (characterization)", () => {
		const result = new BashCommand("head -5 f.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.ok(result!.suggestion.includes("read"));
	});

	it("tail triggers detectMismatch with 'read' suggestion (characterization)", () => {
		const result = new BashCommand("tail -10 f.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.ok(result!.suggestion.includes("read"));
	});

	it("less triggers detectMismatch with 'read' suggestion (characterization)", () => {
		const result = new BashCommand("less f.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.ok(result!.suggestion.includes("read"));
	});

	it("more triggers detectMismatch with 'read' suggestion (characterization)", () => {
		const result = new BashCommand("more f.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.ok(result!.suggestion.includes("read"));
	});

	// ── Phase 1 characterization: edge cases for detectMismatch ──

	it("standalone rg → mismatch with ripgrep_search suggestion", () => {
		const result = new BashCommand("rg pattern").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("backtick rg → mismatch with ripgrep_search suggestion", () => {
		const result = new BashCommand("`rg`").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	// ── Phase 2: piped file→grep now detected via delegation ──

	it("piped file→grep: cat file | grep foo → mismatch (new via delegation)", () => {
		const result = new BashCommand("cat file | grep foo").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("piped file→rg: cat file | rg foo → mismatch (new via delegation)", () => {
		const result = new BashCommand("cat file | rg foo").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("grep with redirect in standalone → mismatch", () => {
		const result = new BashCommand("grep foo > out.txt").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("rg with redirect in standalone → mismatch", () => {
		const result = new BashCommand("rg pattern > out.txt").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("grep as second token (npm grep foo) → null", () => {
		const result = new BashCommand("npm grep foo").detectMismatch();
		assert.equal(result, null);
	});

	it("rg as second token (npm rg foo) → null", () => {
		const result = new BashCommand("npm rg foo").detectMismatch();
		assert.equal(result, null);
	});

	// ── Phase 2: standalone commands with backtick grep/rg in quoted string args ──

	it("standalone gh issue with backtick grep in body → null", () => {
		const result = new BashCommand(
			"gh issue create --body 'uses `grep` for searching'",
		).detectMismatch();
		assert.equal(result, null);
	});

	it("standalone echo with backtick rg in body → null", () => {
		const result = new BashCommand("echo 'testing `rg` in body'").detectMismatch();
		assert.equal(result, null);
	});

	it("head inside quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "head -5"`).detectMismatch();
		assert.equal(result, null);
	});

	it("tail inside quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "tail -10"`).detectMismatch();
		assert.equal(result, null);
	});

	it("less inside quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "less file"`).detectMismatch();
		assert.equal(result, null);
	});

	it("more inside quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "more file"`).detectMismatch();
		assert.equal(result, null);
	});

	it("grep in quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "grep"`).detectMismatch();
		assert.equal(result, null);
	});

	it("rg in quoted argument → null", () => {
		const result = new BashCommand(`gh issue view 123 --title "rg"`).detectMismatch();
		assert.equal(result, null);
	});
});

// ── Behavior: suggestRedirection ──

describe("BashCommand.suggestRedirection", () => {
	it("standalone grep → ripgrep_search", () => {
		assert.equal(new BashCommand("grep foo").suggestRedirection(), "ripgrep_search");
	});

	it("standalone cat → read", () => {
		assert.equal(new BashCommand("cat file.ts").suggestRedirection(), "read");
	});

	it("normal command → null", () => {
		assert.equal(new BashCommand("echo hi").suggestRedirection(), null);
	});

	it("empty command → null", () => {
		assert.equal(new BashCommand("").suggestRedirection(), null);
	});

	it("backtick grep → ripgrep_search", () => {
		assert.equal(new BashCommand("`grep foo`").suggestRedirection(), "ripgrep_search");
	});

	// ── Phase 1 characterization: each READ_BASH_CMDS value triggers suggestRedirection "read" ──

	it("cat triggers suggestRedirection 'read' (characterization)", () => {
		assert.equal(new BashCommand("cat file.ts").suggestRedirection(), "read");
	});

	it("head triggers suggestRedirection 'read' (characterization)", () => {
		assert.equal(new BashCommand("head -5 f.ts").suggestRedirection(), "read");
	});

	it("tail triggers suggestRedirection 'read' (characterization)", () => {
		assert.equal(new BashCommand("tail -10 f.ts").suggestRedirection(), "read");
	});

	it("less triggers suggestRedirection 'read' (characterization)", () => {
		assert.equal(new BashCommand("less f.ts").suggestRedirection(), "read");
	});

	it("more triggers suggestRedirection 'read' (characterization)", () => {
		assert.equal(new BashCommand("more f.ts").suggestRedirection(), "read");
	});

	// ── Phase 2: piped file→grep now detected via delegation ──

	it("piped file→grep: cat file | grep foo → ripgrep_search (new via delegation)", () => {
		assert.equal(new BashCommand("cat file | grep foo").suggestRedirection(), "ripgrep_search");
	});

	it("piped file→rg: cat file | rg foo → ripgrep_search (new via delegation)", () => {
		assert.equal(new BashCommand("cat file | rg foo").suggestRedirection(), "ripgrep_search");
	});

	// ── Phase 1 characterization: edge cases for suggestRedirection ──

	it("piped grep (ls | rg pattern) → null", () => {
		assert.equal(new BashCommand("ls | rg pattern").suggestRedirection(), null);
	});

	it("&& chained grep (cd src && rg foo) → null", () => {
		assert.equal(new BashCommand("cd src && rg foo").suggestRedirection(), null);
	});

	it("&& chained with backtick grep in string arg → null", () => {
		assert.equal(
			new BashCommand("cd src && gh issue comment --body '`` `grep` ``'").suggestRedirection(),
			null,
		);
	});

	it("semicolon chained grep (echo hi; grep foo) → null", () => {
		assert.equal(new BashCommand("echo hi; grep foo").suggestRedirection(), null);
	});

	it("piped cat (ps aux | head -5) → null", () => {
		assert.equal(new BashCommand("ps aux | head -5").suggestRedirection(), null);
	});

	it("cat with write redirect (cat > /tmp/foo) → null", () => {
		assert.equal(new BashCommand("cat > /tmp/foo").suggestRedirection(), null);
	});

	it("ls -la → null (divergence from detectMismatch)", () => {
		assert.equal(new BashCommand("ls -la").suggestRedirection(), null);
	});

	it("standalone rg → ripgrep_search", () => {
		assert.equal(new BashCommand("rg pattern").suggestRedirection(), "ripgrep_search");
	});

	it("backtick rg → ripgrep_search", () => {
		assert.equal(new BashCommand("`rg`").suggestRedirection(), "ripgrep_search");
	});

	it("grep with redirect in standalone → ripgrep_search", () => {
		assert.equal(new BashCommand("grep foo > out.txt").suggestRedirection(), "ripgrep_search");
	});

	it("rg with redirect in standalone → ripgrep_search", () => {
		assert.equal(new BashCommand("rg pattern > out.txt").suggestRedirection(), "ripgrep_search");
	});

	it("grep as second token (npm grep foo) → null", () => {
		assert.equal(new BashCommand("npm grep foo").suggestRedirection(), null);
	});

	it("rg as second token (npm rg foo) → null", () => {
		assert.equal(new BashCommand("npm rg foo").suggestRedirection(), null);
	});

	it("cat inside quoted argument → null", () => {
		assert.equal(
			new BashCommand(`gh issue view 123 --title "cat file"`).suggestRedirection(),
			null,
		);
	});

	it("head inside quoted argument → null", () => {
		assert.equal(new BashCommand(`gh issue view 123 --title "head -5"`).suggestRedirection(), null);
	});

	it("tail inside quoted argument → null", () => {
		assert.equal(
			new BashCommand(`gh issue view 123 --title "tail -10"`).suggestRedirection(),
			null,
		);
	});

	it("less inside quoted argument → null", () => {
		assert.equal(
			new BashCommand(`gh issue view 123 --title "less file"`).suggestRedirection(),
			null,
		);
	});

	it("more inside quoted argument → null", () => {
		assert.equal(
			new BashCommand(`gh issue view 123 --title "more file"`).suggestRedirection(),
			null,
		);
	});

	it("grep in quoted argument → null", () => {
		assert.equal(new BashCommand(`gh issue view 123 --title "grep"`).suggestRedirection(), null);
	});

	it("rg in quoted argument → null", () => {
		assert.equal(new BashCommand(`gh issue view 123 --title "rg"`).suggestRedirection(), null);
	});

	// ── Phase 2: standalone commands with backtick grep/rg in quoted string args ──

	it("standalone gh issue with backtick grep in body → null", () => {
		assert.equal(
			new BashCommand("gh issue create --body 'uses `grep` for text'").suggestRedirection(),
			null,
		);
	});
});

// ── Utility: isStandalone ──

describe("BashCommand.isStandalone", () => {
	it("true for simple single command", () => {
		assert.equal(new BashCommand("grep foo").isStandalone(), true);
		assert.equal(new BashCommand("cat file.ts").isStandalone(), true);
	});

	it("false for piped command", () => {
		assert.equal(new BashCommand("ls | grep foo").isStandalone(), false);
	});

	it("false for && chain", () => {
		assert.equal(new BashCommand("cd src && npm test").isStandalone(), false);
	});

	it("false for semicolon chain", () => {
		assert.equal(new BashCommand("echo hi; echo there").isStandalone(), false);
	});
});

// ── Utility: isLs ──

describe("BashCommand.isLs", () => {
	it("detects bare ls", () => {
		assert.equal(new BashCommand("ls").isLs(), true);
	});

	it("detects ls with flags", () => {
		assert.equal(new BashCommand("ls -la").isLs(), true);
	});

	it("does not detect npm ls", () => {
		assert.equal(new BashCommand("npm ls").isLs(), false);
	});
});

// ── Utility: segments (parseBashCmd access) ──

describe("BashCommand.segments", () => {
	it("returns parsed segments", () => {
		const cmd = new BashCommand("ls -la | grep foo");
		assert.equal(cmd.segments.length, 2);
		assert.deepEqual(cmd.segments[0].tokens, ["ls", "-la"]);
		assert.deepEqual(cmd.segments[1].tokens, ["grep", "foo"]);
	});

	it("returns empty array for empty command", () => {
		const cmd = new BashCommand("");
		assert.deepEqual(cmd.segments, []);
	});
});

// ── Verify: parse once per instance ──

describe("BashCommand parse-once", () => {
	it("parses command once on construction", () => {
		// Multiple method calls should reuse parsed segments
		const cmd = new BashCommand("grep foo");
		assert.equal(cmd.isSearch(), true);
		assert.equal(cmd.isStandalone(), true);
		assert.equal(cmd.isLs(), false);
		// All methods use the same parsed segments
	});
});

// ── Phase 1: BashCommand.from() static factory ──

describe("BashCommand.from", () => {
	it("returns BashCommand instance identical to new BashCommand", () => {
		const from = BashCommand.from("grep foo");
		const direct = new BashCommand("grep foo");
		assert.ok(from instanceof BashCommand);
		assert.equal(from.raw, direct.raw);
		assert.deepEqual(from.segments, direct.segments);
	});

	it("parses command once (segments shared across method calls)", () => {
		const cmd = BashCommand.from("ls -la | grep foo");
		assert.equal(cmd.segments.length, 2);
		assert.equal(cmd.isSearch(), false);
		assert.equal(cmd.isStandalone(), false);
	});

	it("from('') returns instance with empty segments", () => {
		const cmd = BashCommand.from("");
		assert.deepEqual(cmd.segments, []);
		assert.equal(cmd.raw, "");
	});

	it("from('ls | grep foo').isSearch() returns false (piped)", () => {
		assert.equal(BashCommand.from("ls | grep foo").isSearch(), false);
	});

	it("from reuses same parseBashCmd code path as constructor", () => {
		// Same command should produce identical segments
		const cmd = "cat file.ts > output.txt";
		const fromResult = BashCommand.from(cmd);
		const newResult = new BashCommand(cmd);
		assert.equal(fromResult.segments.length, newResult.segments.length);
		assert.equal(fromResult.segments[0]?.redirect, newResult.segments[0]?.redirect);
		assert.deepEqual(fromResult.segments, newResult.segments);
	});

	it("from is a static method (no new required)", () => {
		const cmd = BashCommand.from("echo hi");
		assert.ok(cmd instanceof BashCommand);
		assert.equal(cmd.isStandalone(), true);
	});
});
