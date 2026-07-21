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

	it("new BashCommand('grep foo').isSearch() → true", () => {
		assert.equal(new BashCommand("grep foo").isSearch(), true);
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

	it("new BashCommand('cat file.ts').isFileRead() → true", () => {
		assert.equal(new BashCommand("cat file.ts").isFileRead(), true);
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


