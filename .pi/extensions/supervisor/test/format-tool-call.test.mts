// ─── Tests: formatToolCall() + isToolCallLine() — Phase 1 ────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatToolCall, isToolCallLine } from "../event/session-events.ts";

// ─── Tests: formatToolCall() ─────────────────────────────────────

describe("formatToolCall()", () => {
	// bash
	it('formats bash with command: "$ npm test"', () => {
		assert.equal(formatToolCall("bash", { command: "npm test" }), "$ npm test");
	});

	it('formats bash with no args: "$"', () => {
		assert.equal(formatToolCall("bash", undefined), "$");
	});

	it('formats bash with null args: "$"', () => {
		assert.equal(formatToolCall("bash", null as unknown as Record<string, unknown>), "$");
	});

	it('formats bash with empty command: "$"', () => {
		assert.equal(formatToolCall("bash", { command: "" }), "$");
	});

	// read
	it('formats read with path+offset+limit: "read /path/file.ts:10-30"', () => {
		assert.equal(
			formatToolCall("read", { path: "/path/file.ts", offset: 10, limit: 30 }),
			"read /path/file.ts:10-30",
		);
	});

	it('formats read with path only: "read /path/file.ts"', () => {
		assert.equal(formatToolCall("read", { path: "/path/file.ts" }), "read /path/file.ts");
	});

	it('formats read with no args: "read"', () => {
		assert.equal(formatToolCall("read", {}), "read");
	});

	it('formats read with path and offset only: "read /x:5-"', () => {
		assert.equal(formatToolCall("read", { path: "/x", offset: 5 }), "read /x:5-");
	});

	// write
	it('formats write with path and content: "write /path/file.ts (45 lines)"', () => {
		const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
		assert.equal(
			formatToolCall("write", { path: "/path/file.ts", content }),
			"write /path/file.ts (45 lines)",
		);
	});

	it('formats write with empty content: "write /path (0 lines)"', () => {
		assert.equal(formatToolCall("write", { path: "/path", content: "" }), "write /path (0 lines)");
	});

	it('formats write with single line: "write /path (1 line)"', () => {
		assert.equal(
			formatToolCall("write", { path: "/path", content: "single" }),
			"write /path (1 line)",
		);
	});

	it('formats write with no args: "write"', () => {
		assert.equal(formatToolCall("write", {}), "write");
	});

	// edit
	it('formats edit with path: "edit /path/file.ts"', () => {
		assert.equal(formatToolCall("edit", { path: "/path/file.ts" }), "edit /path/file.ts");
	});

	it('formats edit with no args: "edit"', () => {
		assert.equal(formatToolCall("edit", {}), "edit");
	});

	// grep
	it('formats grep with pattern and path: "grep /function.*{/ in /src"', () => {
		assert.equal(
			formatToolCall("grep", { pattern: "function.*{", path: "/src" }),
			"grep /function.*{/ in /src",
		);
	});

	it('formats grep with pattern only: "grep /foo/"', () => {
		assert.equal(formatToolCall("grep", { pattern: "foo" }), "grep /foo/");
	});

	it('formats grep with no args: "grep"', () => {
		assert.equal(formatToolCall("grep", {}), "grep");
	});

	// ls
	it('formats ls with path: "ls /home"', () => {
		assert.equal(formatToolCall("ls", { path: "/home" }), "ls /home");
	});

	it('formats ls with no args: "ls"', () => {
		assert.equal(formatToolCall("ls", {}), "ls");
	});

	// find
	it('formats find with path and name: "find /src"', () => {
		assert.equal(formatToolCall("find", { path: "/src", name: "*.ts" }), "find /src");
	});

	it('formats find with no args: "find"', () => {
		assert.equal(formatToolCall("find", {}), "find");
	});

	// ripgrep_search
	it('formats ripgrep_search: "rg \"TODO\" in /src"', () => {
		assert.equal(
			formatToolCall("ripgrep_search", { query: "TODO", directory: "/src" }),
			'rg "TODO" in /src',
		);
	});

	it('formats ripgrep_search with query only: "rg \"TODO\""', () => {
		assert.equal(formatToolCall("ripgrep_search", { query: "TODO" }), 'rg "TODO"');
	});

	it('formats ripgrep_search with directory only: "rg in /src"', () => {
		assert.equal(formatToolCall("ripgrep_search", { directory: "/src" }), "rg in /src");
	});

	it('formats ripgrep_search with no args: "rg"', () => {
		assert.equal(formatToolCall("ripgrep_search", {}), "rg");
	});

	// web_search — fallback format
	it('formats web_search as fallback: "web_search: ..."', () => {
		const result = formatToolCall("web_search", { query: "typescript" });
		assert.ok(result.startsWith("web_search: {"));
		assert.ok(result.includes("typescript"));
		assert.ok(result.length <= 80 || result.endsWith("..."));
	});

	// web_crawl — fallback format
	it('formats web_crawl as fallback: "web_crawl: ..."', () => {
		const result = formatToolCall("web_crawl", { url: "https://example.com" });
		assert.ok(result.startsWith("web_crawl: "));
	});

	// ask_user — fallback format
	it('formats ask_user as fallback: "ask_user: ..."', () => {
		const result = formatToolCall("ask_user", { question: "Proceed?" });
		assert.ok(result.startsWith("ask_user: "));
	});

	// structural_search — fallback format
	it('formats structural_search as fallback: "structural_search: ..."', () => {
		const result = formatToolCall("structural_search", { pattern: "console.log($A)" });
		assert.ok(result.startsWith("structural_search: "));
	});

	// unknown tool — fallback format
	it("formats unknown_tool as fallback clipped to ≤80 chars", () => {
		const result = formatToolCall("unknown_tool", { a: 1, b: 2 });
		assert.equal(result, 'unknown_tool: {"a":1,"b":2}');
		assert.ok(result.length <= 80, `length ${result.length} ≤ 80`);
	});

	it("bash with very long command does not clip (bash shows raw command)", () => {
		const longStr = "a".repeat(200);
		const result = formatToolCall("bash", { command: longStr });
		assert.equal(result, `$ ${longStr}`);
	});

	// write with very long content — should show count, not content
	it("write with very long content shows line count not content", () => {
		const content = "line\n".repeat(99) + "line"; // 100 lines total
		const result = formatToolCall("write", { path: "/big.ts", content });
		assert.equal(result, "write /big.ts (100 lines)");
	});
});

// ─── Tests: isToolCallLine() ──────────────────────────────────────

describe("isToolCallLine()", () => {
	it('returns true for "$ npm test"', () => {
		assert.equal(isToolCallLine("$ npm test"), true);
	});

	it('returns true for "read /path/file.ts:10-30"', () => {
		assert.equal(isToolCallLine("read /path/file.ts:10-30"), true);
	});

	it('returns true for "write /path/file.ts (45 lines)"', () => {
		assert.equal(isToolCallLine("write /path/file.ts (45 lines)"), true);
	});

	it('returns true for "edit /path/file.ts"', () => {
		assert.equal(isToolCallLine("edit /path/file.ts"), true);
	});

	it('returns true for "grep /pattern/ in /src"', () => {
		assert.equal(isToolCallLine("grep /pattern/ in /src"), true);
	});

	it('returns true for "ls /home"', () => {
		assert.equal(isToolCallLine("ls /home"), true);
	});

	it('returns true for "find /src"', () => {
		assert.equal(isToolCallLine("find /src"), true);
	});

	it('returns true for "rg \"TODO\" in /src"', () => {
		assert.equal(isToolCallLine('rg "TODO" in /src'), true);
	});

	it('returns true for "rg"', () => {
		assert.equal(isToolCallLine("rg"), true);
	});

	it('returns true for fallback format like "web_search: {...}"', () => {
		assert.equal(isToolCallLine('web_search: {"query":"typescript"}'), true);
	});

	it('returns false for "💭 thinking line"', () => {
		assert.equal(isToolCallLine("💭 thinking line"), false);
	});

	it('returns false for "✓ read_file"', () => {
		assert.equal(isToolCallLine("✓ read_file"), false);
	});

	it('returns false for "✗ read_file"', () => {
		assert.equal(isToolCallLine("✗ read_file"), false);
	});

	it('returns false for "📋 read_file: output"', () => {
		assert.equal(isToolCallLine("📋 read_file: output"), false);
	});

	it('returns false for "📊 Context: 5.0K/10.0K"', () => {
		assert.equal(isToolCallLine("📊 Context: 5.0K/10.0K"), false);
	});

	it("returns false for normal text lines", () => {
		assert.equal(isToolCallLine("Normal text line"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isToolCallLine(""), false);
	});

	it('returns true for bare "$"', () => {
		assert.equal(isToolCallLine("$"), true);
	});

	it('returns true for "ripgrep_search: {...}" (fallback format)', () => {
		assert.equal(isToolCallLine('ripgrep_search: {"pattern":"TODO"}'), true);
	});

	it('returns true for "structural_search: {...}" (fallback format)', () => {
		assert.equal(isToolCallLine('structural_search: {"pattern":"console.log($A)"}'), true);
	});

	it('returns false for old-format "🔧 bash: npm test"', () => {
		assert.equal(isToolCallLine("🔧 bash: npm test"), false);
	});

	it('returns false for old-format "🔧 read: /path"', () => {
		assert.equal(isToolCallLine("🔧 read: /path"), false);
	});
});
