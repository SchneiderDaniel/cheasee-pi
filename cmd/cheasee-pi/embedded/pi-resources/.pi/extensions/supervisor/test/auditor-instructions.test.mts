/**
 * Tests for auditor.md — content validity after Step 0 removal
 *
 * Step 0 "Verify Working Directory" was removed per Issue #700.
 * Worktree verification is now handled by task.ts pipeline injection
 * rather than auditor.md instructions. These tests verify the remaining
 * auditor.md content is structurally valid.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-instructions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDITOR_MD = resolve(__dirname, "../agents/auditor.md");

function readAuditorMd(): string {
	return readFileSync(AUDITOR_MD, "utf-8");
}

// ---------------------------------------------------------------------------
// Structural integrity: remaining sections present
// ---------------------------------------------------------------------------

describe("auditor.md — structural integrity", () => {
	it("contains YAML frontmatter with name field", () => {
		const content = readAuditorMd();
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		assert.ok(match, "Should have YAML frontmatter");
		assert.ok(match[1]!.includes("name: auditor"), "Frontmatter should have name: auditor");
	});

	it("contains '## Your Role' section", () => {
		const content = readAuditorMd();
		assert.ok(content.includes("## Your Role"), "Should have Your Role section");
	});

	it("contains '## Review Dimensions' section", () => {
		const content = readAuditorMd();
		assert.ok(content.includes("## Review Dimensions"), "Should have Review Dimensions section");
	});

	it("contains '## Comment Style' section", () => {
		const content = readAuditorMd();
		assert.ok(content.includes("## Comment Style"), "Should have Comment Style section");
	});

	it("contains '## Rules' section", () => {
		const content = readAuditorMd();
		assert.ok(content.includes("## Rules"), "Should have Rules section");
	});

	it("does NOT contain '## Step 0: Verify Working Directory' heading", () => {
		const content = readAuditorMd();
		assert.ok(
			!content.includes("## Step 0: Verify Working Directory"),
			"Step 0 heading should be removed",
		);
	});

	it("does NOT contain '## Codebase Exploration' heading", () => {
		const content = readAuditorMd();
		assert.ok(
			!content.includes("## Codebase Exploration"),
			"Codebase Exploration should be removed",
		);
	});
});
