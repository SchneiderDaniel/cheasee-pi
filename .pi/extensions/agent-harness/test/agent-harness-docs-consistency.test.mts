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
import { describe, it, after } from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { ALLOWED_CONFIG_KEYS, loadProjectConfig } from "../lib/load-config.ts";

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

// ── Phase 3b: Config examples match the committed config contract (issue #1725) ──

/** Extract the first ```json fenced block that follows the "Config Format" heading. */
function extractConfigFence(content: string): string {
	const heading = content.indexOf("Config Format");
	assert.ok(heading !== -1, "doc must have a Config Format section");
	const fenceStart = content.indexOf("```json", heading);
	assert.ok(fenceStart !== -1, "Config Format section must contain a ```json fence");
	const bodyStart = content.indexOf("\n", fenceStart) + 1;
	const fenceEnd = content.indexOf("```", bodyStart);
	assert.ok(fenceEnd !== -1, "config fence must be closed");
	return content.slice(bodyStart, fenceEnd);
}

const configTempDirs: string[] = [];

after(() => {
	for (const dir of configTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	configTempDirs.length = 0;
});

/** Write a config fence to a temp dir and load it through the real loader. */
function loadFence(fence: string) {
	const dir = mkdtempSync(join(tmpdir(), "harness-docs-config-"));
	configTempDirs.push(dir);
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "harness-config.json"), fence, "utf-8");
	return loadProjectConfig({ isProjectTrusted: () => true }, dir);
}

const DOCS = [
	{ label: "README.md", read: readReadme },
	{ label: "docs/extensions/agent-harness.md", read: readDoc },
] as const;

describe("Phase 3b: Config Format examples match the loader contract", () => {
	for (const { label, read } of DOCS) {
		it(`${label}: config fence parses as JSON and top-level keys ⊆ ALLOWED_CONFIG_KEYS`, () => {
			const parsed = JSON.parse(extractConfigFence(read())) as Record<string, unknown>;
			for (const key of Object.keys(parsed)) {
				assert.ok(
					ALLOWED_CONFIG_KEYS.has(key),
					`${label} uses unsupported config key "${key}" — allowed: ${[...ALLOWED_CONFIG_KEYS].join(", ")}`,
				);
			}
		});

		it(`${label}: config fence has no top-level "tools" key`, () => {
			const parsed = JSON.parse(extractConfigFence(read())) as Record<string, unknown>;
			assert.ok(!("tools" in parsed), `${label} must use "toolMeta", not "tools"`);
		});

		it(`${label}: config fence round-trips through loadProjectConfig (bash threshold 4)`, () => {
			const rules = loadFence(extractConfigFence(read()));
			assert.equal(rules.toolMeta.bash?.cascadeThreshold, 4);
			assert.equal(rules.toolMeta.read?.cascadeThreshold, 6);
			assert.equal(rules.toolMeta.ask_user?.passThrough, true);
		});

		it(`${label}: docs mention toolMeta and state global-vs-per-tool cascadeThreshold precedence`, () => {
			const content = read();
			assert.ok(content.includes("toolMeta"), `${label} must document the toolMeta key`);
			const precedence = content.slice(content.indexOf("### Key Design Decisions"));
			assert.ok(
				/global/i.test(precedence) && /per-tool/i.test(precedence),
				`${label} must state top-level cascadeThreshold is the global default and toolMeta.<tool>.cascadeThreshold the per-tool override`,
			);
		});
	}
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
