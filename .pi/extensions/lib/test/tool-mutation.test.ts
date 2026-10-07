/**
 * Tests for lib/tool-mutation.ts — the shared, fail-closed mutation policy.
 *
 * Entity layer: pure, no I/O, no pi import. Consumed by ripgrep-search
 * (and later structural-analyzer) to decide whether a completed tool may
 * have mutated the search corpus and therefore must invalidate the cache.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/tool-mutation.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import {
	READ_ONLY_TOOL_NAMES,
	shouldInvalidateSearchCache,
} from "../tool-mutation.ts";

describe("shouldInvalidateSearchCache — mutators invalidate", () => {
	it('"write" → true', () => {
		assert.strictEqual(shouldInvalidateSearchCache("write", { path: "a.ts" }), true);
	});

	it('"edit" → true', () => {
		assert.strictEqual(shouldInvalidateSearchCache("edit", { path: "a.ts" }), true);
	});

	it('"multiedit" → true', () => {
		assert.strictEqual(shouldInvalidateSearchCache("multiedit", {}), true);
	});

	it('forward-compatible mutators not in the allowlist → true', () => {
		for (const name of ["apply_patch", "notebook_edit", "frobnicate"]) {
			assert.strictEqual(shouldInvalidateSearchCache(name, {}), true, name);
		}
	});

	it('"bash" → true even for read-only-looking commands', () => {
		for (const cmd of ["git status", "ls", "cat x"]) {
			assert.strictEqual(shouldInvalidateSearchCache("bash", { command: cmd }), true, cmd);
		}
	});

	it('empty string → true', () => {
		assert.strictEqual(shouldInvalidateSearchCache("", {}), true);
	});

	it('non-string toolName (undefined/null/number) → true, no throw', () => {
		for (const bad of [undefined, null, 42, {}, ["write"]]) {
			assert.strictEqual(
				shouldInvalidateSearchCache(bad as unknown as string, {}),
				true,
				String(bad),
			);
		}
	});

	it('case variants "Write"/"READ" → true (allowlist is exact-match)', () => {
		assert.strictEqual(shouldInvalidateSearchCache("Write", {}), true);
		assert.strictEqual(shouldInvalidateSearchCache("READ", {}), true);
	});
});

describe("shouldInvalidateSearchCache — read-only names preserve the cache", () => {
	it("every allowlisted read-only tool → false", () => {
		const readOnly = [
			"read",
			"grep",
			"find",
			"ls",
			"ripgrep_search",
			"structural_search",
			"web_search",
			"ask_user",
		];
		for (const name of readOnly) {
			assert.strictEqual(shouldInvalidateSearchCache(name, {}), false, name);
		}
	});

	it("input is accepted and ignored", () => {
		assert.strictEqual(shouldInvalidateSearchCache("read", { path: "a" }), false);
		assert.strictEqual(shouldInvalidateSearchCache("write", {}), true);
		assert.strictEqual(
			shouldInvalidateSearchCache("write", undefined as unknown as Record<string, unknown>),
			true,
		);
	});
});

describe("READ_ONLY_TOOL_NAMES — invariants", () => {
	it("excludes write, edit, multiedit, bash", () => {
		for (const name of ["write", "edit", "multiedit", "bash"]) {
			assert.strictEqual(READ_ONLY_TOOL_NAMES.has(name), false, name);
		}
	});

	it("is a frozen/immutable ReadonlySet", () => {
		assert.strictEqual(typeof READ_ONLY_TOOL_NAMES.has, "function");
	});
});

describe("shouldInvalidateSearchCache — purity", () => {
	it("same args return same result across repeated calls", () => {
		for (let i = 0; i < 3; i++) {
			assert.strictEqual(shouldInvalidateSearchCache("read", {}), false);
			assert.strictEqual(shouldInvalidateSearchCache("write", {}), true);
			assert.strictEqual(shouldInvalidateSearchCache("mystery", {}), true);
		}
	});
});
