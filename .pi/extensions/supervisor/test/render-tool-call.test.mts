// ─── Tests: renderToolCallText() + isToolCallLine() ───────────────
// Delegates to pi's native renderCall for built-in tools.
// Extension tools use JSON-preview fallback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToolCallText, isToolCallLine, getBuiltinToolLabels } from "../lib/render-helpers.ts";

const CWD = "/repo";

// ─── Tests: renderToolCallText() — built-in tools ───────────────
// Note: expected strings match pi's native renderCall output, which
// differs from the old formatToolCall format (intentional drift alignment).

describe("renderToolCallText — bash", () => {
	it('formats bash with command: "$ npm test"', () => {
		assert.equal(renderToolCallText("bash", { command: "npm test" }, CWD), "$ npm test");
	});

	it('bash with no args returns "$ ..." (pi\'s empty-command fallback)', () => {
		const result = renderToolCallText("bash", {}, CWD);
		assert.ok(result.startsWith("$"));
	});

	it('bash with null args returns "$ ..." (pi\'s empty-command fallback)', () => {
		const result = renderToolCallText("bash", null, CWD);
		assert.ok(result.startsWith("$"));
	});

	it('bash with empty command returns "$ ..." (pi\'s empty-command fallback)', () => {
		const result = renderToolCallText("bash", { command: "" }, CWD);
		assert.ok(result.startsWith("$"));
	});
});

describe("renderToolCallText — read", () => {
	it('formats read with path+offset+limit: "read /path/file.ts:10-39" (pi 1-indexed)', () => {
		assert.equal(
			renderToolCallText("read", { path: "/path/file.ts", offset: 10, limit: 30 }, CWD),
			"read /path/file.ts:10-39",
		);
	});

	it('formats read with path only: "read /path/file.ts"', () => {
		assert.equal(renderToolCallText("read", { path: "/path/file.ts" }, CWD), "read /path/file.ts");
	});

	it('formats read with no args: "read ..." (pi shows "..." for missing path)', () => {
		assert.equal(renderToolCallText("read", {}, CWD), "read ...");
	});
});

describe("renderToolCallText — write", () => {
	it('formats write with path and content (multi-line, starts with path)', () => {
		const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = renderToolCallText("write", { path: "/path/file.ts", content }, CWD);
		assert.ok(result.startsWith("write /path/file.ts"));
	});

	it('formats write with no args: "write ..." (pi shows "..." for missing path)', () => {
		assert.equal(renderToolCallText("write", {}, CWD), "write ...");
	});
});

describe("renderToolCallText — edit", () => {
	it('formats edit with path: "edit /path/file.ts"', () => {
		assert.equal(renderToolCallText("edit", { path: "/path/file.ts" }, CWD), "edit /path/file.ts");
	});

	it('formats edit with no args: "edit ..." (pi shows "..." for missing path)', () => {
		assert.equal(renderToolCallText("edit", {}, CWD), "edit ...");
	});
});

describe("renderToolCallText — grep", () => {
	it('formats grep with pattern and path: includes pattern and path', () => {
		const result = renderToolCallText("grep", { pattern: "function.*{", path: "/src" }, CWD);
		assert.ok(result.includes("/function.*{/"));
		assert.ok(result.includes("/src"));
	});

	it('formats grep with no args: "grep // in ." (pi always shows full format)', () => {
		assert.equal(renderToolCallText("grep", {}, CWD), "grep // in .");
	});
});

describe("renderToolCallText — ls", () => {
	it('formats ls with path: "ls /path"', () => {
		assert.equal(renderToolCallText("ls", { path: "/home" }, CWD), "ls /home");
	});

	it('formats ls with no args: "ls ." (pi shows "." for empty path)', () => {
		assert.equal(renderToolCallText("ls", {}, CWD), "ls .");
	});
});

describe("renderToolCallText — find", () => {
	it('formats find with path and pattern: "find <pattern> in /path"', () => {
		const result = renderToolCallText("find", { path: "/src", pattern: "*.ts" }, CWD);
		assert.equal(result, "find *.ts in /src");
	});

	it('formats find with path only: "find  in /src" (empty pattern)', () => {
		const result = renderToolCallText("find", { path: "/src", name: "*.ts" }, CWD);
		assert.ok(result.includes("/src"));
	});

	it('formats find with no args: "find  in ." (pi shows "in .")', () => {
		assert.equal(renderToolCallText("find", {}, CWD), "find  in .");
	});
});

// ─── Tests: renderToolCallText() — extension tool fallback ─────

describe("renderToolCallText — extension tool fallback (JSON preview)", () => {
	it('ripgrep_search uses name: JSON format', () => {
		const result = renderToolCallText("ripgrep_search", { query: "TODO", directory: "/src" }, CWD);
		assert.ok(result.startsWith("ripgrep_search: "));
		assert.ok(result.includes("TODO"));
	});

	it('web_search uses name: JSON format', () => {
		const result = renderToolCallText("web_search", { query: "typescript" }, CWD);
		assert.ok(result.startsWith("web_search: "));
	});

	it('web_crawl uses name: JSON format', () => {
		const result = renderToolCallText("web_crawl", { url: "https://example.com" }, CWD);
		assert.ok(result.startsWith("web_crawl: "));
	});

	it('ask_user uses name: JSON format', () => {
		const result = renderToolCallText("ask_user", { question: "Proceed?" }, CWD);
		assert.ok(result.startsWith("ask_user: "));
	});

	it('structural_search uses name: JSON format', () => {
		const result = renderToolCallText("structural_search", { pattern: "console.log($A)" }, CWD);
		assert.ok(result.startsWith("structural_search: "));
	});

	it('unknown_tool uses name: JSON format clipped to ≤80 chars', () => {
		const result = renderToolCallText("unknown_tool", { a: 1, b: 2 }, CWD);
		assert.equal(result, 'unknown_tool: {"a":1,"b":2}');
		assert.ok(result.length <= 80);
	});

	it('JSON preview is clipped to ≤80 chars for large args', () => {
		const large = { data: "x".repeat(200) };
		const result = renderToolCallText("ripgrep_search", large, CWD);
		assert.ok(result.length <= 80, `expected ≤80 chars, got ${result.length}`);
		assert.ok(result.endsWith("..."));
	});
});

// ─── Tests: getBuiltinToolLabels() ───────────────────────────────

describe("getBuiltinToolLabels", () => {
	it("returns Set containing all 7 built-in tool names", () => {
		const labels = getBuiltinToolLabels();
		assert.ok(labels.has("read"));
		assert.ok(labels.has("bash"));
		assert.ok(labels.has("edit"));
		assert.ok(labels.has("write"));
		assert.ok(labels.has("grep"));
		assert.ok(labels.has("find"));
		assert.ok(labels.has("ls"));
		assert.equal(labels.size, 7);
	});

	it("does not include extension tools", () => {
		const labels = getBuiltinToolLabels();
		assert.equal(labels.has("ripgrep_search"), false);
		assert.equal(labels.has("web_search"), false);
	});
});

// ─── Tests: isToolCallLine() ──────────────────────────────────────

describe("isToolCallLine", () => {
	it('returns true for "$ npm test"', () => {
		assert.equal(isToolCallLine("$ npm test"), true);
	});

	it('returns true for "read /path/file.ts:10-39"', () => {
		assert.equal(isToolCallLine("read /path/file.ts:10-39"), true);
	});

	it('returns true for "write /path (45 lines)"', () => {
		assert.equal(isToolCallLine("write /path (45 lines)"), true);
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

	it('returns true for fallback format like "web_search: {...}"', () => {
		assert.equal(isToolCallLine('web_search: {"query":"typescript"}'), true);
	});

	it('returns true for "ripgrep_search: {...}" (fallback format)', () => {
		assert.equal(isToolCallLine('ripgrep_search: {"pattern":"TODO"}'), true);
	});

	it('returns true for "structural_search: {...}" (fallback format)', () => {
		assert.equal(isToolCallLine('structural_search: {"pattern":"console.log($A)"}'), true);
	});

	it('returns true for bare "$"', () => {
		assert.equal(isToolCallLine("$"), true);
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

	it('returns false for old-format "🔧 bash: npm test"', () => {
		assert.equal(isToolCallLine("🔧 bash: npm test"), false);
	});

	it('returns false for old-format "🔧 read: /path"', () => {
		assert.equal(isToolCallLine("🔧 read: /path"), false);
	});
});

// ─── Tests: Drift detection — supervisor matches pi's renderer ──

describe("renderToolCallText drift detection", () => {
	it("bash output equals pi's native renderCall output (via stripAnsi)", () => {
		const result = renderToolCallText("bash", { command: "echo hi" }, CWD);
		assert.equal(result, "$ echo hi");
	});

	it("read output equals pi's native renderCall output", () => {
		const result = renderToolCallText("read", { path: "/etc/hostname", offset: 1, limit: 5 }, CWD);
		// pi renders 1-indexed: offset=1 → startLine=1, limit=5 → endLine=5
		assert.ok(result.startsWith("read /etc/hostname"));
		assert.ok(result.includes(":1-5"));
	});

	it("edit output equals pi's native renderCall output", () => {
		const result = renderToolCallText("edit", { path: "/repo/file.ts" }, CWD);
		assert.equal(result, "edit /repo/file.ts");
	});

	it("ls output equals pi's native renderCall output", () => {
		const result = renderToolCallText("ls", { path: "/tmp" }, CWD);
		assert.equal(result, "ls /tmp");
	});

	it("find output equals pi's native renderCall output", () => {
		const result = renderToolCallText("find", { path: "/src", pattern: "*.ts" }, CWD);
		assert.equal(result, "find *.ts in /src");
	});

	it("grep output equals pi's native renderCall output", () => {
		const result = renderToolCallText("grep", { pattern: "TODO", path: "/src" }, CWD);
		assert.equal(result, "grep /TODO/ in /src");
	});
});
