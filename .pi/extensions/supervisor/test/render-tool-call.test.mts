// ─── Tests: renderToolCallText() + cwd-aware path display ───────
// Delegates to pi's native renderCall for built-in tools.
// Extension tools use JSON-preview fallback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToolCallText } from "../lib/tool-call-text.ts";
import { getBuiltinToolLabels } from "../lib/tool-line.ts";
import { isToolLine } from "../lib/tool-line.ts";

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
	it("formats write with path and content (multi-line, starts with path)", () => {
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
	it("formats grep with pattern and path: includes pattern and path", () => {
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
	it("ripgrep_search uses name: JSON format", () => {
		const result = renderToolCallText("ripgrep_search", { query: "TODO", directory: "/src" }, CWD);
		assert.ok(result.startsWith("ripgrep_search: "));
		assert.ok(result.includes("TODO"));
	});

	it("web_search uses name: JSON format", () => {
		const result = renderToolCallText("web_search", { query: "typescript" }, CWD);
		assert.ok(result.startsWith("web_search: "));
	});

	it("web_crawl uses name: JSON format", () => {
		const result = renderToolCallText("web_crawl", { url: "https://example.com" }, CWD);
		assert.ok(result.startsWith("web_crawl: "));
	});

	it("ask_user uses name: JSON format", () => {
		const result = renderToolCallText("ask_user", { question: "Proceed?" }, CWD);
		assert.ok(result.startsWith("ask_user: "));
	});

	it("structural_search uses name: JSON format", () => {
		const result = renderToolCallText("structural_search", { pattern: "console.log($A)" }, CWD);
		assert.ok(result.startsWith("structural_search: "));
	});

	it("unknown_tool uses name: JSON format clipped to ≤80 chars", () => {
		const result = renderToolCallText("unknown_tool", { a: 1, b: 2 }, CWD);
		assert.equal(result, 'unknown_tool: {"a":1,"b":2}');
		assert.ok(result.length <= 80);
	});

	it("JSON preview is clipped to ≤80 chars for large args", () => {
		const large = { data: "x".repeat(200) };
		const result = renderToolCallText("ripgrep_search", large, CWD);
		assert.ok(result.length <= 80, `expected ≤80 chars, got ${result.length}`);
		assert.ok(result.endsWith("..."));
	});
});

// ─── Tests: getBuiltinToolLabels() ───────────────────────────────

describe("getBuiltinToolLabels", () => {
	it("returns Set containing all 8 built-in tool names (including rg)", () => {
		const labels = getBuiltinToolLabels();
		assert.ok(labels.has("read"));
		assert.ok(labels.has("bash"));
		assert.ok(labels.has("edit"));
		assert.ok(labels.has("write"));
		assert.ok(labels.has("grep"));
		assert.ok(labels.has("find"));
		assert.ok(labels.has("ls"));
		assert.ok(labels.has("rg"));
		assert.equal(labels.size, 8);
	});

	it("does not include extension tools", () => {
		const labels = getBuiltinToolLabels();
		assert.equal(labels.has("ripgrep_search"), false);
		assert.equal(labels.has("web_search"), false);
	});
});

// ─── Tests: isToolLine() ──────────────────────────────────────────

describe("isToolLine", () => {
	it("recognizes bash lines starting with $", () => {
		assert.ok(isToolLine("$ npm test"));
		assert.ok(isToolLine("$ ls -la"));
	});

	it("recognizes bare dollar sign", () => {
		assert.ok(isToolLine("$"));
	});

	it("recognizes built-in tool names by first word", () => {
		assert.ok(isToolLine("read /path/file.ts:1-10"));
		assert.ok(isToolLine("edit /path/file.ts"));
		assert.ok(isToolLine("write /path (2 lines)"));
		assert.ok(isToolLine("grep /pattern/ in /src"));
		assert.ok(isToolLine("ls /home"));
		assert.ok(isToolLine("find *.ts in /src"));
	});

	it("recognizes rg as default tool name", () => {
		assert.ok(isToolLine('rg "TODO" in /src'));
	});

	it("recognizes extension tools with trailing colon", () => {
		const extTools = new Set([
			"ripgrep_search",
			"web_search",
			"web_crawl",
			"structural_search",
			"ask_user",
		]);
		assert.ok(isToolLine('ripgrep_search: {"query":"TODO"}', extTools));
		assert.ok(isToolLine('web_search: {"query":"typescript"}', extTools));
		assert.ok(isToolLine('ask_user: {"question":"Proceed?"}', extTools));
	});

	it("uses provided toolNames set instead of default", () => {
		const customTools = new Set(["my_tool"]);
		assert.ok(isToolLine("my_tool: some args", customTools));
		assert.ok(!isToolLine("read /path", customTools));
	});

	it("returns false for empty/null line", () => {
		assert.equal(isToolLine(""), false);
		assert.equal(isToolLine("   "), false);
	});

	it("returns false for non-tool lines", () => {
		assert.equal(isToolLine("Some random text"), false);
		assert.equal(isToolLine("# comment line"), false);
		assert.equal(isToolLine("// code comment"), false);
	});
});

// ─── Tests: cwd-aware path display (Phase 1) ────────────────────

describe("renderToolCallText — cwd-aware path display", () => {
	it("cwd resolves relative paths for read", () => {
		const result = renderToolCallText("read", { path: "relative/file.ts" }, "/home/user");
		// pi's renderCall resolves relative paths against cwd and may show absolute path
		assert.ok(
			result.includes("relative/file.ts") || result.includes("/home/user/relative/file.ts"),
		);
	});

	it("cwd resolves relative paths for write", () => {
		const result = renderToolCallText(
			"write",
			{ path: "relative/file.ts", content: "line1" },
			"/home/user",
		);
		assert.ok(
			result.includes("relative/file.ts") || result.includes("/home/user/relative/file.ts"),
		);
	});

	it("cwd resolves relative paths for edit", () => {
		const result = renderToolCallText("edit", { path: "relative/file.ts" }, "/home/user");
		assert.ok(
			result.includes("relative/file.ts") || result.includes("/home/user/relative/file.ts"),
		);
	});

	it("cwd does not affect absolute paths", () => {
		const result = renderToolCallText("read", { path: "/etc/hostname" }, "/home/user");
		assert.equal(result, "read /etc/hostname");
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

// ═══════════════════════════════════════════════════════════════════════
// Built-in dispatch table (issue #2102) — seven pi factories, one cast
// ═══════════════════════════════════════════════════════════════════════

/** Representative args that make each built-in renderer produce output. */
const BUILTIN_ARGS: Record<string, unknown> = {
	bash: { command: "npm test" },
	read: { path: "/repo/file.ts", offset: 1, limit: 5 },
	write: { path: "/repo/file.ts", content: "line1\nline2" },
	edit: { path: "/repo/file.ts" },
	grep: { pattern: "TODO", path: "/repo/src" },
	find: { path: "/repo/src", pattern: "*.ts" },
	ls: { path: "/repo" },
};

const BUILTIN_NAMES = Object.keys(BUILTIN_ARGS);

describe("renderToolCallText — built-in dispatch", () => {
	for (const name of BUILTIN_NAMES) {
		it(`${name} goes through pi's native renderCall, not the JSON fallback`, () => {
			const result = renderToolCallText(name, BUILTIN_ARGS[name], CWD);
			assert.equal(
				new RegExp(`^(${BUILTIN_NAMES.join("|")}): \\{`).test(result),
				false,
				`${name} must not fall back to JSON preview: ${result}`,
			);
		});

		it(`${name} emits no ANSI escape codes`, () => {
			const result = renderToolCallText(name, BUILTIN_ARGS[name], CWD);
			assert.equal(
				/[\u001b\u009b]/.test(result),
				false,
				`ANSI leaked into: ${JSON.stringify(result)}`,
			);
		});
	}

	it("pins the seven-factory / eight-label gap: rg has no factory", () => {
		assert.equal(renderToolCallText("rg", { pattern: "TODO" }, CWD), 'rg: {"pattern":"TODO"}');
	});

	it("routes all five extension tools through the JSON preview", () => {
		for (const name of [
			"ripgrep_search",
			"web_search",
			"web_crawl",
			"structural_search",
			"ask_user",
		]) {
			const result = renderToolCallText(name, { query: "TODO" }, CWD);
			assert.ok(result.startsWith(`${name}: `), `${name} must use the JSON preview`);
		}
	});

	it("renders an unknown tool as a JSON preview", () => {
		assert.equal(
			renderToolCallText("unknown_tool", { a: 1, b: 2 }, CWD),
			'unknown_tool: {"a":1,"b":2}',
		);
	});

	it("clips large args to at most 80 chars ending in ...", () => {
		const large = { query: "x".repeat(400) };
		const result = renderToolCallText("ripgrep_search", large, CWD);
		assert.ok(result.length <= 80, `preview must be clipped, got ${result.length} chars`);
		assert.ok(result.endsWith("..."), "clipped preview must end with ...");
	});

	it("pins the empty-args table for every built-in", () => {
		const expected: Record<string, string> = {
			bash: "$ ...",
			read: "read ...",
			write: "write ...",
			edit: "edit ...",
			grep: "grep // in .",
			find: "find  in .",
			ls: "ls .",
		};
		for (const [name, want] of Object.entries(expected)) {
			assert.equal(renderToolCallText(name, undefined, CWD), want, `${name} with undefined args`);
			assert.equal(renderToolCallText(name, null, CWD), want, `${name} with null args`);
		}
	});

	it("characterization: an extension tool with undefined args throws TypeError", () => {
		// Deliberately preserved (not fixed here): JSON.stringify(undefined) is
		// undefined, so the preview length read throws. Tracked as a follow-up.
		assert.throws(() => renderToolCallText("ripgrep_search", undefined, CWD), TypeError);
	});

	it("ensureTheme is idempotent across sequential calls", () => {
		const outputs: string[] = [];
		for (let i = 0; i < 6; i++) {
			outputs.push(renderToolCallText("bash", { command: "npm test" }, CWD));
		}
		for (const out of outputs) assert.equal(out, outputs[0]);
		assert.equal(outputs[0], "$ npm test");
	});

	it("keeps the exported 3-argument signature (tsc-enforced)", () => {
		const fn: (name: string, args: unknown, cwd: string) => string = renderToolCallText;
		assert.equal(typeof fn, "function");
		assert.equal(renderToolCallText.length, 3);
	});
});
