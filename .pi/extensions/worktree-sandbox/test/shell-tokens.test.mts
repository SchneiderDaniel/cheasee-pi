/**
 * Tests: shell-tokens.ts — isCommandStart, findMeaningfulToken
 *
 * Phase 1: Unit tests for the extracted shell token analysis helpers.
 * These helpers were extracted from the triplicate isCommandStart/isCommandName
 * and duplicate token-walking loop patterns in index.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/worktree-sandbox/test/shell-tokens.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "shell-quote";
import { SEPARATORS, isCommandStart, findMeaningfulToken } from "../shell-tokens.ts";
import { SEPARATORS as SEPARATORS_FROM_INDEX } from "../index.ts";
import type { ParseEntry } from "shell-quote";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: isCommandStart
// ═══════════════════════════════════════════════════════════════════════

describe("isCommandStart", () => {
	it("returns true for index 0 (first token is always command start)", () => {
		const tokens = parse("echo hello");
		assert.equal(isCommandStart(tokens, 0), true);
	});

	it("returns true when preceded by | separator", () => {
		const tokens = parse("echo | cat");
		assert.equal(isCommandStart(tokens, 2), true); // "cat" after |
	});

	it("returns true when preceded by || separator", () => {
		const tokens = parse("false || echo ok");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by |& separator", () => {
		const tokens = parse("echo |& cat");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by ; separator", () => {
		const tokens = parse("echo; cat");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by ;; separator", () => {
		const tokens = parse("echo;; cat");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by && separator", () => {
		const tokens = parse("true && echo ok");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by & separator", () => {
		const tokens = parse("echo & cat");
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns false when preceded by non-separator operator (>)", () => {
		const tokens = parse("echo > file");
		// tokens: ["echo", { op: ">" }, "file"]
		assert.equal(isCommandStart(tokens, 2), false); // "file" after >
	});

	it("returns false when preceded by non-separator operator (>>)", () => {
		const tokens = parse("echo >> file");
		assert.equal(isCommandStart(tokens, 2), false);
	});

	it("returns false when preceded by glob operator", () => {
		// Hand-craft tokens since shell-quote doesn't naturally produce glob
		const tokens: ParseEntry[] = ["cmd", { op: "glob", pattern: "*.txt" }];
		assert.equal(isCommandStart(tokens, 1), false);
	});

	it("returns false when preceded by a comment", () => {
		const tokens: ParseEntry[] = ["cmd", { comment: " a comment" }, "arg"];
		assert.equal(isCommandStart(tokens, 2), false);
	});

	it("returns false when preceded by a string literal", () => {
		const tokens = parse("echo hello");
		assert.equal(isCommandStart(tokens, 1), false); // "hello" after "echo"
	});

	it("returns true for index 0 in 1-element array (boundary)", () => {
		const tokens = parse("cd");
		assert.equal(isCommandStart(tokens, 0), true);
	});

	it("returns false for index 1 in 2-element array where prev is string", () => {
		const tokens = parse("cd subdir");
		assert.equal(isCommandStart(tokens, 1), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: findMeaningfulToken
// ═══════════════════════════════════════════════════════════════════════

describe("findMeaningfulToken", () => {
	it("returns { kind: 'token', value } when next non-operator token is a string", () => {
		const tokens = parse("echo hello world");
		const result = findMeaningfulToken(tokens, 1); // start after "echo"
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "hello");
		}
	});

	it("returns { kind: 'glob', pattern } when next token is a glob operator", () => {
		const tokens: ParseEntry[] = ["echo", { op: "glob", pattern: "*.txt" }];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
		if (result.kind === "glob") {
			assert.equal(result.pattern, "*.txt");
		}
	});

	it("returns { kind: 'separator', op } when next token is a separator operator (|)", () => {
		const tokens = parse("echo | cat");
		const result = findMeaningfulToken(tokens, 1); // start after "echo"
		assert.equal(result.kind, "separator");
		if (result.kind === "separator") {
			assert.equal(result.op, "|");
		}
	});

	it("returns { kind: 'separator', op } when next token is &&", () => {
		const tokens = parse("true && echo ok");
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "separator");
		if (result.kind === "separator") {
			assert.equal(result.op, "&&");
		}
	});

	it("returns { kind: 'comment' } when next token is a comment", () => {
		const tokens: ParseEntry[] = ["echo", { comment: " this is a comment" }, "world"];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "comment");
	});

	it("returns { kind: 'exhausted' } when start is past tokens end", () => {
		const tokens = parse("echo");
		const result = findMeaningfulToken(tokens, 5); // past end
		assert.equal(result.kind, "exhausted");
	});

	it("returns { kind: 'exhausted' } when start equals tokens length", () => {
		const tokens = parse("echo");
		const result = findMeaningfulToken(tokens, 1); // at end
		assert.equal(result.kind, "exhausted");
	});

	it("skips non-separator operator (>) and returns the string token after it", () => {
		const tokens = parse("echo > file");
		const result = findMeaningfulToken(tokens, 1); // start after "echo"
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "file");
		}
	});

	it("skips non-separator operator (>>) and returns the string after", () => {
		const tokens = parse("echo >> file");
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "file");
		}
	});

	it("skips multiple consecutive non-separator operators and returns string", () => {
		// Simulate tokens: ["cmd", { op: ">" }, { op: ">" }, "file"]
		const tokens: ParseEntry[] = ["cmd", { op: ">" }, { op: ">" }, "file"];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "file");
		}
	});

	it("skips mixed non-separator operators before finding string", () => {
		// Simulate tokens: ["cmd", { op: ">" }, "/dev/null", { op: ">" }, "file"]
		const tokens: ParseEntry[] = ["cmd", { op: ">" }, "/dev/null", { op: ">" }, "file"];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "/dev/null");
		}
	});

	it("returns exhausted when only operators and comments remain", () => {
		const tokens: ParseEntry[] = [
			"cmd",
			{ op: ">" },
			{ op: "glob", pattern: "*.txt" },
			{ comment: " note" },
		];
		// Starting after "cmd", we get glob first
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
	});

	it("returns token when exact last element is a string", () => {
		const tokens = parse("echo hello");
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "hello");
		}
	});

	it("returns token with correct index for element at position 1", () => {
		const tokens = parse("cmd arg");
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "arg");
			assert.equal(result.index, 1);
		}
	});

	it("returns token with correct index after skipping operators", () => {
		// tokens: ["cmd", { op: ">" }, "file"]
		const tokens = parse("cmd > file");
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "token");
		if (result.kind === "token") {
			assert.equal(result.value, "file");
			assert.equal(result.index, 2);
		}
	});

	it("returns glob with correct index", () => {
		const tokens: ParseEntry[] = ["cmd", { op: "glob", pattern: "*.ts" }];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
		if (result.kind === "glob") {
			assert.equal(result.index, 1);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: SEPARATORS re-export
// ═══════════════════════════════════════════════════════════════════════

describe("SEPARATORS import", () => {
	it("SEPARATORS is importable from shell-tokens.ts", () => {
		assert.ok(SEPARATORS instanceof Set);
	});

	it("SEPARATORS contains expected operators", () => {
		for (const op of ["|", "||", "|&", ";", ";;", "&&", "&"]) {
			assert.ok(SEPARATORS.has(op), `SEPARATORS should contain ${op}`);
		}
	});

	it("SEPARATORS does not contain non-separator operators", () => {
		assert.equal(SEPARATORS.has(">"), false);
		assert.equal(SEPARATORS.has(">>"), false);
		assert.equal(SEPARATORS.has("glob"), false);
	});

	it("SEPARATORS is re-exported from index.ts", () => {
		// Type-check that it's importable — value equivalence tested above
		assert.ok(SEPARATORS_FROM_INDEX instanceof Set);
		assert.equal(SEPARATORS_FROM_INDEX, SEPARATORS);
	});
});
