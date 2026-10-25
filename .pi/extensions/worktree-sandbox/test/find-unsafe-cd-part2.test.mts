import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { SEPARATORS, isCommandStart, findMeaningfulToken } from "../index.ts";

import type { ParseEntry } from "shell-quote";

const SANDBOX_ROOT = "/tmp/sandbox-test-root";

describe("isCommandStart (ported from shell-tokens.test.mts)", () => {
	it("returns true when preceded by ;; separator", () => {
		const tokens: ParseEntry[] = ["echo", { op: ";;" }, "cat"];
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by |& separator", () => {
		const tokens: ParseEntry[] = ["echo", { op: "|&" }, "cat"];
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns true when preceded by & separator", () => {
		const tokens: ParseEntry[] = ["echo", { op: "&" }, "cat"];
		assert.equal(isCommandStart(tokens, 2), true);
	});

	it("returns false when preceded by glob operator", () => {
		const tokens: ParseEntry[] = ["cmd", { op: "glob", pattern: "*.txt" }];
		assert.equal(isCommandStart(tokens, 1), false);
	});
});
describe("findMeaningfulToken (ported from shell-tokens.test.mts)", () => {
	it("returns glob when next token is a glob operator", () => {
		const tokens: ParseEntry[] = ["echo", { op: "glob", pattern: "*.txt" }];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
		if (result.kind === "glob") {
			assert.equal(result.pattern, "*.txt");
		}
	});

	it("returns glob at correct index", () => {
		const tokens: ParseEntry[] = ["cmd", { op: "glob", pattern: "*.ts" }];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
		if (result.kind === "glob") {
			assert.equal(result.index, 1);
		}
	});

	it("skips non-separator operators and returns glob when it encounters one", () => {
		const tokens: ParseEntry[] = [
			"cmd",
			{ op: ">" },
			{ op: "glob", pattern: "*.txt" },
			{ comment: " note" },
		];
		const result = findMeaningfulToken(tokens, 1);
		assert.equal(result.kind, "glob");
	});
});
describe("SEPARATORS (ported from shell-tokens.test.mts)", () => {
	it("does not contain non-separator operators", () => {
		assert.equal(SEPARATORS.has(">"), false);
		assert.equal(SEPARATORS.has(">>"), false);
		assert.equal(SEPARATORS.has("glob"), false);
	});
});
