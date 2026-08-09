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

const DOC_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "extensions", "agent-harness.md");
const README_PATH = resolve(import.meta.dirname, "..", "README.md");

function readDoc(): string {
	return readFileSync(DOC_PATH, "utf-8");
}

function readReadme(): string {
	return readFileSync(README_PATH, "utf-8");
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
