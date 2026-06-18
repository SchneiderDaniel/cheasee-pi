/**
 * Tests for extension-duplicate-code-hunter skill added to auditor agent.
 *
 * Phase 1: Skills frontmatter — verify `skills: extension-duplicate-code-hunter` in YAML
 * Phase 2: 4e Code Quality methodology instructions — verify detection references
 * Phase 3: Regression — existing resolveSkillPaths behavior unchanged
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-extension-duplicate-code-hunter.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkillPaths, resolveSkillPathsWithFs } from "../lib/extensions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDITOR_MD = resolve(__dirname, "../agents/auditor.md");

function readAuditorMd(): string {
	return readFileSync(AUDITOR_MD, "utf-8");
}

/**
 * Extract YAML frontmatter from auditor.md as an array of lines.
 */
function getFrontmatterLines(content: string): string[] {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return [];
	return match[1]!.split("\n");
}

/**
 * Extract a specific field from YAML frontmatter.
 */
function getFrontmatterField(content: string, field: string): string | undefined {
	const lines = getFrontmatterLines(content);
	for (const line of lines) {
		const kv = line.match(new RegExp(`^${field}\\s*:\\s*(.+)$`));
		if (kv) return kv[1]!.trim();
	}
	return undefined;
}

// ─── Phase 1: Skills frontmatter ──────────────────────────────────

describe("auditor.md — skills frontmatter (Phase 1)", () => {
	it("contains 'skills' field in YAML frontmatter", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal !== undefined, "YAML frontmatter should contain 'skills' field");
	});

	it("skills field value includes 'extension-duplicate-code-hunter'", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("extension-duplicate-code-hunter"),
			`skills value '${skillsVal}' should include 'extension-duplicate-code-hunter'`,
		);
	});

	it("skills line appears between 'extensions:' and closing '---'", () => {
		const content = readAuditorMd();
		const lines = getFrontmatterLines(content);
		const extIdx = lines.findIndex((l) => l.startsWith("extensions:"));
		const skillsIdx = lines.findIndex((l) => l.startsWith("skills:"));
		assert.ok(extIdx >= 0, "extensions field must exist");
		assert.ok(skillsIdx >= 0, "skills field must exist");
		assert.ok(
			skillsIdx > extIdx,
			`skills line (index ${skillsIdx}) should appear after extensions line (index ${extIdx})`,
		);
	});

	it("skills value contains both skills", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		// Normalize: strip quotes and whitespace
		const normalized = skillsVal!.replace(/["']/g, "").trim();
		assert.ok(
			normalized.includes("extension-duplicate-code-hunter") &&
				normalized.includes("extension-dead-code-hunter"),
			`skills value '${normalized}' should contain both 'extension-duplicate-code-hunter' and 'extension-dead-code-hunter'`,
		);
	});

	it("frontmatter has at least 8 lines (skills line added)", () => {
		const content = readAuditorMd();
		const lines = getFrontmatterLines(content);
		// auditor.md frontmatter now has: name, description, tools, model, thinking, extensions, skills = 7 fields
		assert.ok(lines.length >= 7, `Frontmatter should have at least 7 lines, got ${lines.length}`);
	});
});

// ─── Phase 2: 4e Code Quality methodology instructions ────────────

describe("auditor.md — Code Quality duplicate detection (Phase 2)", () => {
	it("skills frontmatter includes 'extension-duplicate-code-hunter' skill", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("extension-duplicate-code-hunter"),
			"skills field should include 'extension-duplicate-code-hunter'",
		);
	});

	it("Code Quality dimension exists in Review Dimensions table", () => {
		const content = readAuditorMd();
		assert.ok(
			content.includes("Code Quality"),
			"auditor.md should reference Code Quality dimension",
		);
	});

	it("Review Dimensions table mentions duplication in Code Quality", () => {
		const content = readAuditorMd();
		const reviewTable = content.substring(
			content.indexOf("| **Architecture Compliance"),
			content.indexOf("## Your Task"),
		);
		assert.ok(
			reviewTable.includes("duplication") || reviewTable.includes("duplicate"),
			"Code Quality dimension should reference duplication",
		);
	});

	it("auditor invokes extension-duplicate-code-hunter skill via skills mechanism", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("extension-dead-code-hunter"),
			"skills field should also include 'extension-dead-code-hunter'",
		);
	});

	it("tools include ripgrep_search and structural_search for code analysis", () => {
		const content = readAuditorMd();
		const toolsVal = getFrontmatterField(content, "tools");
		assert.ok(toolsVal, "tools field must exist");
		assert.ok(toolsVal!.includes("ripgrep_search"), "tools field should include ripgrep_search");
		assert.ok(
			toolsVal!.includes("structural_search"),
			"tools field should include structural_search",
		);
	});
});

// ─── Phase 3: Regression — resolveSkillPaths ──────────────────────

describe("resolveSkillPaths regression (Phase 3)", () => {
	it("resolveSkillPaths('extension-duplicate-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("extension-duplicate-code-hunter");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith(".pi/skills/extension-duplicate-code-hunter/SKILL.md") ||
				result[0]!.endsWith("extension-duplicate-code-hunter/SKILL.md"),
			`Path should end with extension-duplicate-code-hunter/SKILL.md, got ${result[0]}`,
		);
	});

	it("resolveSkillPaths('extension-spec') still resolves correctly (regression)", () => {
		const result = resolveSkillPaths("extension-spec");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith("extension-spec/SKILL.md") || result[0]!.endsWith("extension-spec.md"),
		);
	});

	it("resolveSkillPaths('') returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths(""), []);
	});

	it("resolveSkillPaths(undefined) returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths(undefined), []);
	});

	it("resolveSkillPaths('   ') returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths("   "), []);
	});

	it("resolveSkillPaths('nonexistent-skill-xyz') throws (regression)", () => {
		assert.throws(() => resolveSkillPaths("nonexistent-skill-xyz"), /nonexistent-skill-xyz/);
	});
});
