// ─── Tests: agent/scope.ts — scope derivation and file-scope checking ──
// Pure functions, no mocking needed.

import assert from "node:assert";
import { describe, it } from "node:test";
import { deriveScopeFromLabels, isInScope } from "../../agent/scope.ts";

// ─── Extension directories fixture ───────────────────────────────

const EXTENSION_DIRS = [
	"agent-harness",
	"context-info",
	"supervisor",
	"caveman",
	"check-extensions",
	"format-on-save",
	"lsp-auditor",
	"piignore",
	"ripgrep-search",
	"scrapling",
	"session-advice",
	"session-logger",
	"structural-analyzer",
	"tsc-checkpoint",
	"web-search",
	"worktree-sandbox",
];

// ─── Phase 1: deriveScopeFromLabels ──────────────────────────────

describe("deriveScopeFromLabels", () => {
	it("no matching label returns null (backward compat, no restriction)", () => {
		const result = deriveScopeFromLabels(["bug", "enhancement"], EXTENSION_DIRS);
		assert.strictEqual(result, null);
	});

	it("supervisor label returns .pi/extensions/supervisor/", () => {
		const result = deriveScopeFromLabels(["supervisor"], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/supervisor/");
	});

	it("documentation label returns *.md", () => {
		const result = deriveScopeFromLabels(["documentation"], EXTENSION_DIRS);
		assert.strictEqual(result, "*.md");
	});

	it("agent-harness label returns .pi/extensions/agent-harness/", () => {
		const result = deriveScopeFromLabels(["agent-harness"], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/agent-harness/");
	});

	it("unknown-extension label with matching extensionDirs returns .pi/extensions/unknown-extension/", () => {
		const dirs = [...EXTENSION_DIRS, "unknown-extension"];
		const result = deriveScopeFromLabels(["unknown-extension"], dirs);
		assert.strictEqual(result, ".pi/extensions/unknown-extension/");
	});

	it("multiple labels matches first matching label", () => {
		const result = deriveScopeFromLabels(["supervisor", "documentation"], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/supervisor/");
	});

	it("no matching label in extensionDirs returns null", () => {
		const result = deriveScopeFromLabels(["nonexistent-label"], EXTENSION_DIRS);
		assert.strictEqual(result, null);
	});

	it("empty labels array returns null", () => {
		const result = deriveScopeFromLabels([], EXTENSION_DIRS);
		assert.strictEqual(result, null);
	});

	it("documentation label with custom extension dirs still maps to *.md", () => {
		const result = deriveScopeFromLabels(["documentation", "custom-ext"], ["custom-ext"]);
		assert.strictEqual(result, "*.md");
	});

	it("label matching is case-insensitive", () => {
		const result = deriveScopeFromLabels(["Supervisor"], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/supervisor/");
	});

	it("label with whitespace is trimmed before matching", () => {
		const result = deriveScopeFromLabels(["  supervisor  "], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/supervisor/");
	});

	it("context-info label returns .pi/extensions/context-info/", () => {
		const result = deriveScopeFromLabels(["context-info"], EXTENSION_DIRS);
		assert.strictEqual(result, ".pi/extensions/context-info/");
	});
});

// ─── Phase 1: isInScope ──────────────────────────────────────────

describe("isInScope", () => {
	it("scope=null returns true (no restriction)", () => {
		assert.strictEqual(isInScope(".pi/extensions/supervisor/x.ts", null), true);
	});

	it("file inside scope path returns true", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope(".pi/extensions/supervisor/handler.ts", scope), true);
	});

	it("file inside scope path (no trailing slash on scope) returns true", () => {
		const scope = ".pi/extensions/supervisor";
		assert.strictEqual(isInScope(".pi/extensions/supervisor/handler.ts", scope), true);
	});

	it("file outside scope path returns false", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope(".pi/extensions/agent-harness/x.ts", scope), false);
	});

	it("CVE #6631 bypass: relative path alternation returns false after normalization", () => {
		const scope = ".pi/extensions/supervisor/";
		// path.resolve("/", "../../outside/supervisor/file.ts") resolves to "/outside/supervisor/file.ts"
		// which does NOT start with "/.pi/extensions/supervisor/"
		assert.strictEqual(isInScope("../../outside/supervisor/file.ts", scope), false);
	});

	it("*.md scope: markdown file returns true", () => {
		const scope = "*.md";
		assert.strictEqual(isInScope("README.md", scope), true);
	});

	it("*.md scope: markdown file in subdirectory returns true", () => {
		const scope = "*.md";
		assert.strictEqual(isInScope("docs/guide.md", scope), true);
	});

	it("*.md scope: .ts file returns false", () => {
		const scope = "*.md";
		assert.strictEqual(isInScope("src/index.ts", scope), false);
	});

	it("sibling directory prefix collision returns false", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope(".pi/extensions/supervisor-backup/x.ts", scope), false);
	});

	it("sibling directory prefix collision without trailing slash on scope returns false", () => {
		const scope = ".pi/extensions/supervisor";
		assert.strictEqual(isInScope(".pi/extensions/supervisor-backup/x.ts", scope), false);
	});

	it("empty file path returns false", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope("", scope), false);
	});

	it("scope with trailing slash mismatch matches correctly", () => {
		const scope = ".pi/extensions/supervisor";
		assert.strictEqual(isInScope(".pi/extensions/supervisor/x.ts", scope), true);
	});

	it("file exactly at scope path (no subpath) returns true", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope(".pi/extensions/supervisor", scope), true);
	});

	it("file deeply nested inside scope returns true", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(
			isInScope(".pi/extensions/supervisor/agent/deeply/nested/file.ts", scope),
			true,
		);
	});

	it("file in parent directory of scope returns false", () => {
		const scope = ".pi/extensions/supervisor/";
		assert.strictEqual(isInScope(".pi/extensions/config.ts", scope), false);
	});

	it("*.md scope: .MD uppercase extension returns true", () => {
		const scope = "*.md";
		assert.strictEqual(isInScope("README.MD", scope), true);
	});

	it("*.md scope: file with .md somewhere in name (not extension) returns false", () => {
		const scope = "*.md";
		assert.strictEqual(isInScope("mod-file.ts", scope), false);
	});
});
