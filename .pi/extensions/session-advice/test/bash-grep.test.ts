/**
 * Tests for waste-signals/bash-grep.ts — detectBashGrep
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/bash-grep.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectBashGrep } from "../waste-signals/bash-grep.ts";
import { makeSession, bashEntry } from "./session-test-helpers.ts";

describe("detectBashGrep", () => {
	it("flags 'cat file | grep foo' → 1 bash-grep signal", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("cat file | grep foo", 0)])).length,
			1,
			"bash | grep should be flagged",
		);
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("cat file | grep foo", 0)]))[0].signal,
			"bash-grep",
		);
	});

	it("flags 'cat file | rg pattern' → 1 signal", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("cat file.txt | rg pattern", 0)])).length,
			1,
			"bash | rg should be flagged",
		);
	});

	it("flags 'head -n 20 file | grep foo'", () => {
		const data = makeSession([bashEntry("head -n 20 file | grep foo", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 1, "head | grep should be flagged");
	});

	it("flags 'tail -f log | grep error'", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("tail -f log | grep error", 0)])).length,
			1,
			"tail | grep should be flagged",
		);
	});

	it("flags 'less file | grep foo'", () => {
		const data = makeSession([bashEntry("less file | grep foo", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 1, "less | grep should be flagged");
	});

	it("flags 'more file | grep foo'", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("more file | grep foo", 0)])).length,
			1,
			"more | grep should be flagged",
		);
	});

	it("does NOT flag 'ctags --list-maps | grep typescript' (command output pipe)", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("ctags --list-maps | grep typescript", 0)])).length,
			0,
			"ctags | grep should NOT be flagged",
		);
	});

	it("does NOT flag 'git branch -a | grep 599'", () => {
		const data = makeSession([bashEntry("git branch -a | grep 599", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 0, "git branch | grep should NOT be flagged");
	});

	it("does NOT flag 'gh issue list | grep bug'", () => {
		const data = makeSession([bashEntry("gh issue list | grep bug", 0)]);
		assert.strictEqual(
			detectBashGrep(data).length,
			0,
			"gh issue list | grep should NOT be flagged",
		);
	});

	it("does NOT flag 'ls | grep -v node_modules'", () => {
		assert.strictEqual(
			detectBashGrep(makeSession([bashEntry("ls | grep -v node_modules", 0)])).length,
			0,
			"ls | grep should NOT be flagged",
		);
	});

	it("does NOT flag 'ps aux | grep node'", () => {
		const data = makeSession([bashEntry("ps aux | grep node", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 0, "ps aux | grep should NOT be flagged");
	});

	it("does NOT flag 'docker ps | grep myapp'", () => {
		const data = makeSession([bashEntry("docker ps | grep myapp", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 0, "docker ps | grep should NOT be flagged");
	});

	it("does NOT flag 'npm test' (non-search)", () => {
		assert.strictEqual(detectBashGrep(makeSession([bashEntry("npm test", 0)])).length, 0);
	});

	it("does NOT flag 'node build.js'", () => {
		const data = makeSession([bashEntry("node build.js", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 0);
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectBashGrep(makeSession([])).length, 0);
	});

	// ── Bug fix: variant pipe spacing now handled by bash-query regex ──

	it("variant spacing: cat file |  grep foo (two spaces after pipe) → 1 signal", () => {
		const data = makeSession([bashEntry("cat file |  grep foo", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 1);
	});

	it("variant spacing: cat file |grep foo (no space after pipe) → 1 signal", () => {
		const data = makeSession([bashEntry("cat file |grep foo", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 1);
	});

	it("word boundary: cat file | grepped → 0 signals (prefix match rejected)", () => {
		const data = makeSession([bashEntry("cat file | grepped", 0)]);
		assert.strictEqual(detectBashGrep(data).length, 0);
	});
});
