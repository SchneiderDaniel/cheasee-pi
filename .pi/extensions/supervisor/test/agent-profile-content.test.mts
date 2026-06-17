/**
 * Tests for agent .md profile content (Issue #934 — Fix 1+2)
 *
 * Phase 1: Agent .md file content verification
 *
 * Fix 1 — Tool Reference: developer.md lists edit tool schema (only agent with `edit` tool)
 * Fix 2 — Project Commands: developer.md and auditor.md contain project commands
 * No changes to researcher.md (no `edit` tool, not in scope for Project Commands)
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AGENTS_DIR = path.resolve(__dirname, "..", "agents");

function readAgentFile(filename: string): string {
	const filePath = path.join(AGENTS_DIR, filename);
	return fs.readFileSync(filePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 1: Fix 1 — Tool Reference section
// ---------------------------------------------------------------------------

describe("agent .md files — Tool Reference section (Issue #934 Fix 1)", () => {
	it("developer.md contains ## Tool Reference section", () => {
		const content = readAgentFile("developer.md");
		assert.ok(
			content.includes("## Tool Reference"),
			"developer.md should have Tool Reference heading",
		);
	});

	it("developer.md ## Tool Reference lists edit with oldText and newText", () => {
		const content = readAgentFile("developer.md");
		assert.ok(content.includes("`oldText` (string)"), "Should document oldText field");
		assert.ok(content.includes("`newText` (string)"), "Should document newText field");
	});

	it("developer.md ## Tool Reference lists location, position, mode, index as invalid", () => {
		const content = readAgentFile("developer.md");
		assert.ok(content.includes("`location`"), "Should name location as invalid");
		assert.ok(content.includes("`position`"), "Should name position as invalid");
		assert.ok(content.includes("`mode`"), "Should name mode as invalid");
		assert.ok(content.includes("`index`"), "Should name index as invalid");
	});

	it("developer.md ## Tool Reference says 'No other fields are accepted'", () => {
		const content = readAgentFile("developer.md");
		assert.ok(content.includes("No other fields are accepted"));
	});

	it("auditor.md does NOT contain ## Tool Reference section", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(
			!content.includes("## Tool Reference"),
			"auditor.md should NOT have Tool Reference (no edit tool)",
		);
	});

	it("researcher.md does NOT contain ## Tool Reference section", () => {
		const content = readAgentFile("researcher.md");
		assert.ok(
			!content.includes("## Tool Reference"),
			"researcher.md should NOT have Tool Reference (no edit tool)",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 1: Fix 2 — Project Commands section
// ---------------------------------------------------------------------------

describe("agent .md files — Project Commands section (Issue #934 Fix 2)", () => {
	it("developer.md contains ## Project Commands section", () => {
		const content = readAgentFile("developer.md");
		assert.ok(
			content.includes("## Project Commands"),
			"developer.md should have Project Commands heading",
		);
	});

	it("developer.md ## Project Commands includes npm run tsc:extensions", () => {
		const content = readAgentFile("developer.md");
		assert.ok(
			content.includes("npm run tsc:extensions"),
			"developer.md should mention tsc:extensions",
		);
	});

	it("developer.md ## Project Commands includes npm test", () => {
		const content = readAgentFile("developer.md");
		assert.ok(content.includes("npm test"), "developer.md should mention npm test");
	});

	it("auditor.md contains ## Project Commands section", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(
			content.includes("## Project Commands"),
			"auditor.md should have Project Commands heading",
		);
	});

	it("auditor.md ## Project Commands includes npm run tsc:extensions", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(
			content.includes("npm run tsc:extensions"),
			"auditor.md should mention tsc:extensions",
		);
	});

	it("auditor.md ## Project Commands includes npm test", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(content.includes("npm test"), "auditor.md should mention npm test");
	});

	it("researcher.md does NOT contain ## Project Commands section", () => {
		const content = readAgentFile("researcher.md");
		assert.ok(
			!content.includes("## Project Commands"),
			"researcher.md should NOT have Project Commands (not in scope)",
		);
	});
});

// ---------------------------------------------------------------------------
// Regression: existing content preserved
// ---------------------------------------------------------------------------

describe("agent .md files — existing content preserved (no regression)", () => {
	it("developer.md preserves Tools line with edit", () => {
		const content = readAgentFile("developer.md");
		assert.ok(
			content.includes("tools: read, bash, write, edit,"),
			"Tools line should still list edit",
		);
	});

	it("auditor.md preserves Tools line (no edit)", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(
			content.includes("tools: read, bash, structural_search, ripgrep_search"),
			"auditor tools unchanged",
		);
	});

	it("researcher.md unchanged — no Tool Reference, no Project Commands", () => {
		const content = readAgentFile("researcher.md");
		assert.ok(!content.includes("## Tool Reference"), "No Tool Reference in researcher.md");
		assert.ok(!content.includes("## Project Commands"), "No Project Commands in researcher.md");
	});

	it("developer.md still contains original Rules section", () => {
		const content = readAgentFile("developer.md");
		assert.ok(content.includes("## Rules"), "developer.md should still have Rules section");
		assert.ok(content.includes("TEST FIRST"), "Should still contain TEST FIRST rule");
	});

	it("auditor.md still contains original Review Dimensions heading", () => {
		const content = readAgentFile("auditor.md");
		assert.ok(
			content.includes("## Review Dimensions"),
			"auditor.md should still have Review Dimensions",
		);
	});
});
