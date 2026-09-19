/**
 * Verify agent-harness docs are consistent with implementation.
 *
 * Issue #1347: The docs speculatively claimed xxd/hexdump detection in the
 * Tool Mismatch Detection table, but the code never implemented it.
 * This test:
 *   - Confirms xxd/hexdump are NOT mentioned in either doc's mismatch table
 *   - Confirms table integrity (no broken rows after removal)
 *   - Confirms no stale xxd/hexdump references outside .git/
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentHarness } from "../index.ts";

const DOC_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "extensions", "agent-harness.md");
const README_PATH = resolve(import.meta.dirname, "..", "README.md");
const SECURITY_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "security.md");
const ROOT_README_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "README.md");
const PACKAGE_JSON_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "package.json");

function readDoc(): string {
	return readFileSync(DOC_PATH, "utf-8");
}

function readReadme(): string {
	return readFileSync(README_PATH, "utf-8");
}

function readSecurity(): string {
	return readFileSync(SECURITY_PATH, "utf-8");
}

// ── Phase 1: Row absent from both doc files ──────────────────────

describe("Phase 1: No xxd/hexdump in Tool Mismatch Detection tables", () => {
	it("docs/extensions/agent-harness.md table has no xxd", () => {
		const doc = readDoc();
		// Only the table section, not the whole file
		const tableStart = doc.indexOf("Tool Mismatch Detection");
		const afterTable = doc.indexOf("### Key Design Decisions", tableStart);
		const table = doc.slice(tableStart, afterTable !== -1 ? afterTable : undefined);
		assert.ok(!table.includes("xxd"), "xxd should not appear in Tool Mismatch Detection section");
	});

	it("docs/extensions/agent-harness.md table has no hexdump", () => {
		const doc = readDoc();
		const tableStart = doc.indexOf("Tool Mismatch Detection");
		const afterTable = doc.indexOf("### Key Design Decisions", tableStart);
		const table = doc.slice(tableStart, afterTable !== -1 ? afterTable : undefined);
		assert.ok(!table.includes("hexdump"), "hexdump should not appear in Tool Mismatch Detection section");
	});

	it(".pi/extensions/agent-harness/README.md table has no xxd", () => {
		const readme = readReadme();
		const tableStart = readme.indexOf("Tool Mismatch Detection");
		const afterTable = readme.indexOf("### Key Design Decisions", tableStart);
		const table = readme.slice(tableStart, afterTable !== -1 ? afterTable : undefined);
		assert.ok(!table.includes("xxd"), "xxd should not appear in Tool Mismatch Detection section");
	});

	it(".pi/extensions/agent-harness/README.md table has no hexdump", () => {
		const readme = readReadme();
		const tableStart = readme.indexOf("Tool Mismatch Detection");
		const afterTable = readme.indexOf("### Key Design Decisions", tableStart);
		const table = readme.slice(tableStart, afterTable !== -1 ? afterTable : undefined);
		assert.ok(!table.includes("hexdump"), "hexdump should not appear in Tool Mismatch Detection section");
	});
});

// ── Phase 2: Table integrity after row deletion ──────────────────

describe("Phase 2: Table structure preserved after row deletion", () => {
	function extractTable(content: string): string {
		const start = content.indexOf("Tool Mismatch Detection");
		const end = content.indexOf("### Key Design Decisions", start);
		return content.slice(start, end !== -1 ? end : undefined);
	}

	function tableRows(content: string): string[] {
		return content.split("\n").filter(l => l.trim().startsWith("|"));
	}

	it("docs/extensions/agent-harness.md table has 6 pipe rows (1 header + 1 separator + 4 data)", () => {
		const rows = tableRows(extractTable(readDoc()));
		assert.strictEqual(rows.length, 6,
			"Expected 6 pipe rows: 1 header + 1 separator + 4 data rows");
	});

	it("docs/extensions/agent-harness.md separator row has 3 dash columns", () => {
		const rows = tableRows(extractTable(readDoc()));
		// Second row is the separator (|---|...|)
		const separator = rows[1];
		const dashBlocks = separator.split("|").filter(c => /^-+$/.test(c.trim()));
		assert.strictEqual(dashBlocks.length, 3,
			"Separator row should have exactly 3 column dividers");
	});

	it("docs/extensions/agent-harness.md each row starts and ends with pipe", () => {
		const rows = tableRows(extractTable(readDoc()));
		for (const row of rows) {
			const trimmed = row.trim();
			assert.ok(trimmed.startsWith("|"), `Row should start with |: "${trimmed}"`);
			assert.ok(trimmed.endsWith("|"), `Row should end with |: "${trimmed}"`);
		}
	});

	it(".pi/extensions/agent-harness/README.md table has 6 pipe rows (1 header + 1 separator + 4 data)", () => {
		const rows = tableRows(extractTable(readReadme()));
		assert.strictEqual(rows.length, 6,
			"Expected 6 pipe rows: 1 header + 1 separator + 4 data rows");
	});

	it(".pi/extensions/agent-harness/README.md separator row has 3 dash columns", () => {
		const rows = tableRows(extractTable(readReadme()));
		const separator = rows[1];
		const dashBlocks = separator.split("|").filter(c => /^-+$/.test(c.trim()));
		assert.strictEqual(dashBlocks.length, 3,
			"Separator row should have exactly 3 column dividers");
	});

	it(".pi/extensions/agent-harness/README.md each row starts and ends with pipe", () => {
		const rows = tableRows(extractTable(readReadme()));
		for (const row of rows) {
			const trimmed = row.trim();
			assert.ok(trimmed.startsWith("|"), `Row should start with |: "${trimmed}"`);
			assert.ok(trimmed.endsWith("|"), `Row should end with |: "${trimmed}"`);
		}
	});
});

// ── Phase 3: No stale references beyond .git/ ────────────────────

describe("Phase 3: No stale xxd/hexdump detection claims outside .git/", () => {
	it("no file outside .git/ contains 'bash xxd' as detection claim", () => {
		const doc = readDoc();
		const readme = readReadme();
		assert.ok(!doc.includes("bash xxd"), "doc should not contain 'bash xxd'");
		assert.ok(!readme.includes("bash xxd"), "README should not contain 'bash xxd'");
	});

	it("no file outside .git/ contains 'bash hexdump' as detection claim", () => {
		const doc = readDoc();
		const readme = readReadme();
		assert.ok(!doc.includes("bash hexdump"), "doc should not contain 'bash hexdump'");
		assert.ok(!readme.includes("bash hexdump"), "README should not contain 'bash hexdump'");
	});
});

// ══════════════════════════════════════════════════════════════════
// Issue #1727: docs claim the read cache "returns cached content".
// The implementation stores an existence marker and, in TUI mode, blocks
// a redundant re-read with a hint — it returns no bytes. These guards keep
// the docs describing the marker+block contract, not a content-return one.
// ══════════════════════════════════════════════════════════════════

const CONTENT_RETURN = /returns? cached (content|result)/i;
const STORES_FILE_CONTENTS = /stores? (the )?file contents/i;
const SAME_FILE_INVALIDATION = /invalidat\w+ on [^.]*\bto (the )?same file/i;

// ── Phase 1: No content-return claim survives in any of the 3 docs ──

describe("Phase 1 (read cache): no content-return claim", () => {
	it(".pi/extensions/agent-harness/README.md has no 'returns cached content/result' claim", () => {
		assert.doesNotMatch(readReadme(), CONTENT_RETURN);
	});

	it("docs/extensions/agent-harness.md has no 'returns cached content/result' claim", () => {
		assert.doesNotMatch(readDoc(), CONTENT_RETURN);
	});

	it("docs/security.md has no 'returns cached content/result' claim", () => {
		assert.doesNotMatch(readSecurity(), CONTENT_RETURN);
	});

	it("neither harness doc claims the read cache stores file contents", () => {
		assert.doesNotMatch(readReadme(), STORES_FILE_CONTENTS);
		assert.doesNotMatch(readDoc(), STORES_FILE_CONTENTS);
	});

	it("docs/extensions/agent-harness.md has no wrong HarnessState readCache type", () => {
		assert.doesNotMatch(readDoc(), /readCache:\s*TimedMap<string,\s*string>/);
		assert.doesNotMatch(readDoc(), /filePath\s*(→|->)\s*contents/i);
	});

	it("neither harness doc claims same-file-only invalidation", () => {
		assert.doesNotMatch(readReadme(), SAME_FILE_INVALIDATION);
		assert.doesNotMatch(readDoc(), SAME_FILE_INVALIDATION);
	});

	it("root docs/README.md has no read-cache content-return claim", () => {
		assert.doesNotMatch(readFileSync(ROOT_README_PATH, "utf-8"), CONTENT_RETURN);
	});
});

// ── Phase 2: Accurate marker+block contract present ──

describe("Phase 2 (read cache): accurate contract present in both harness docs", () => {
	const bothDocs = () => [readReadme(), readDoc()];

	it("both docs call the read cache an existence marker", () => {
		for (const d of bothDocs()) assert.match(d, /marker/i);
	});

	it("both docs describe a cache hit as blocking with a hint, not returning data", () => {
		for (const d of bothDocs()) {
			assert.match(d, /block/i);
			assert.match(d, /content already in (the )?(agent )?context|does not return|no bytes/i);
		}
	});

	it("both docs state the path+offset+limit cache-key scope", () => {
		for (const d of bothDocs()) assert.match(d, /path\+offset\+limit|path, ?offset, ?limit/i);
	});

	it("both docs state the non-TUI pass-through branch", () => {
		for (const d of bothDocs()) assert.match(d, /non-TUI/i);
	});

	it("both docs state the dual TTL (6 turns + 30 s)", () => {
		for (const d of bothDocs()) {
			assert.match(d, /6[- ]turn/i);
			assert.match(d, /30\s*s(econds?)?\b|30_000/);
		}
	});

	it("both docs state invalidation clears the entire cache", () => {
		for (const d of bothDocs()) {
			assert.match(d, /clear/i);
			assert.match(d, /entire/i);
		}
	});

	it("docs/security.md read-caching bullet describes a block + 6-turn TTL", () => {
		const bullet = readSecurity()
			.split("\n")
			.find(l => l.trim().startsWith("-") && /read cach/i.test(l));
		assert.ok(bullet, "read-caching bullet should exist in docs/security.md");
		assert.match(bullet!, /block/i);
		assert.match(bullet!, /6[- ]turn/i);
	});
});

// ── Phase 3: Mermaid diagram nodes corrected ──

function mermaid(content: string): string {
	return [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]).join("\n");
}

describe("Phase 3 (read cache): mermaid nodes describe a block, not content return", () => {
	it("README mermaid has no 'Return cached content' node", () => {
		const m = mermaid(readReadme());
		assert.doesNotMatch(m, /Return cached content/i);
		assert.match(m, /\[Block[^\]]*(context|hint)/i);
	});

	it("docs/extensions/agent-harness.md mermaid has no 'Return cached content' node", () => {
		const m = mermaid(readDoc());
		assert.doesNotMatch(m, /Return cached content/i);
		assert.match(m, /\[Block[^\]]*(context|hint)/i);
	});
});

// ── Phase 4: Behavior characterization lock (source of truth unchanged) ──

describe("Phase 4 (read cache): behavior characterization lock", () => {
	function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
		return { toolName, input: args, isError };
	}
	const tui = () => ({ hasUI: true });
	const nonTui = () => ({ hasUI: false });

	it("TUI: re-read across turns blocks with a hint and carries no content", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui()), null);
		h.handleTurnStart();
		const r = h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui());
		assert.ok(r, "expected a block result");
		assert.equal(r!.block, true);
		assert.match(r!.reason, /Content cached from turn 0/);
		assert.deepEqual(Object.keys(r!).sort(), ["block", "reason"], "result must not carry file content");
	});

	it("non-TUI: same sequence passes through", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), nonTui()), null);
		h.handleTurnStart();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), nonTui()), null);
	});

	it("same turn, same path/offset/limit passes through", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui()), null);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui()), null);
	});

	it("different offset/limit or path is a cache miss", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }), tui());
		h.handleTurnStart();
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 50, limit: 20 }), tui()),
			null,
		);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "b.ts" }), tui()), null);
	});

	it("read without path is not cached", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", {}), tui()), null);
		h.handleTurnStart();
		assert.equal(h.handleToolCall(makeEvent("read", {}), tui()), null);
	});

	it("write clears the entire cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui());
		h.handleToolCall(makeEvent("write", { path: "other.ts", content: "x" }), tui());
		h.handleTurnStart();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), tui()), null);
	});
});

// ── Phase 5: Enforcement wiring ──

describe("Phase 5 (read cache): docs-consistency test wired into npm test", () => {
	it("package.json test script registers the agent-harness docs-consistency test", () => {
		const pkg = readFileSync(PACKAGE_JSON_PATH, "utf-8");
		assert.ok(
			pkg.includes(".pi/extensions/agent-harness/test/agent-harness-docs-consistency.test.mts"),
			"npm test must register the agent-harness docs-consistency test",
		);
	});
});
