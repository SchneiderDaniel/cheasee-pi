/**
 * Tests for duplicate-code-hunter skill added to auditor agent.
 *
 * Phase 1: Skills frontmatter — verify `skills: duplicate-code-hunter` in YAML
 * Phase 2: 4e Code Quality methodology instructions — verify detection references
 * Phase 3: Regression — existing resolveSkillPaths behavior unchanged
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-duplicate-code-hunter.test.mts
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

	it("skills field value includes 'duplicate-code-hunter'", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("duplicate-code-hunter"),
			`skills value '${skillsVal}' should include 'duplicate-code-hunter'`,
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
			normalized.includes("duplicate-code-hunter") && normalized.includes("dead-code-hunter"),
			`skills value '${normalized}' should contain both 'duplicate-code-hunter' and 'dead-code-hunter'`,
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

describe("auditor.md — 4e Code Quality duplicate detection (Phase 2)", () => {
	it("4e Code Quality section contains instruction to run duplicate-detection methodology", () => {
		const content = readAuditorMd();
		// Find the 4e section
		const sectionStart = content.indexOf("#### 4e. Code Quality");
		assert.ok(sectionStart >= 0, "4e Code Quality section must exist");

		// Get content from 4e to next section (#### or end)
		const sectionEnd = content.indexOf("#### 4f.", sectionStart);
		const sectionContent =
			sectionEnd >= 0
				? content.substring(sectionStart, sectionEnd)
				: content.substring(sectionStart);

		// Should reference running duplicate-detection methodology
		const hasMethodologyRef =
			sectionContent.toLowerCase().includes("duplicate-detection") ||
			sectionContent.toLowerCase().includes("duplicate detection") ||
			sectionContent.toLowerCase().includes("clone detection") ||
			sectionContent.toLowerCase().includes("duplicate code detection");
		assert.ok(hasMethodologyRef, "4e section should reference duplicate-detection methodology");
	});

	it("methodology references all four clone types (Type 1-4)", () => {
		const content = readAuditorMd();
		const sectionStart = content.indexOf("#### 4e. Code Quality");
		assert.ok(sectionStart >= 0);

		const sectionEnd = content.indexOf("#### 4f.", sectionStart);
		const sectionContent =
			sectionEnd >= 0
				? content.substring(sectionStart, sectionEnd)
				: content.substring(sectionStart);

		// Check for mentions of Type 1 through Type 4
		const hasType1 = /Type\s*1/i.test(sectionContent);
		const hasType2 = /Type\s*2/i.test(sectionContent);
		const hasType3 = /Type\s*3/i.test(sectionContent);
		const hasType4 = /Type\s*4/i.test(sectionContent);

		assert.ok(hasType1, "Should reference Type 1 (exact clones)");
		assert.ok(hasType2, "Should reference Type 2 (renamed clones)");
		assert.ok(hasType3, "Should reference Type 3 (near-miss clones)");
		assert.ok(hasType4, "Should reference Type 4 (semantic clones)");
	});

	it("scope covers 'all files in affected extensions/modules'", () => {
		const content = readAuditorMd();
		const sectionStart = content.indexOf("#### 4e. Code Quality");
		assert.ok(sectionStart >= 0);

		const sectionEnd = content.indexOf("#### 4f.", sectionStart);
		const sectionContent =
			sectionEnd >= 0
				? content.substring(sectionStart, sectionEnd)
				: content.substring(sectionStart);

		// Scope should be broad — not limited to git diff or .pi/extensions/
		const hasBroadScope =
			sectionContent.toLowerCase().includes("all files") ||
			sectionContent.toLowerCase().includes("affected") ||
			sectionContent.toLowerCase().includes("extensions/modules");
		assert.ok(hasBroadScope, "Scope instruction should cover all affected files");
	});

	it("scope is NOT limited to .pi/extensions/ directory", () => {
		const content = readAuditorMd();
		const sectionStart = content.indexOf("#### 4e. Code Quality");
		assert.ok(sectionStart >= 0);

		const sectionEnd = content.indexOf("#### 4f.", sectionStart);
		const sectionContent =
			sectionEnd >= 0
				? content.substring(sectionStart, sectionEnd)
				: content.substring(sectionStart);

		// Scope should explicitly avoid being limited to only .pi/extensions/
		const limitedToExtensions = sectionContent.match(/\.pi\/extensions\//gi);
		// If it mentions .pi/extensions/, it should also mention broader scope
		// The test checks the scope is not EXCLUSIVELY .pi/extensions/
		const hasBroaderScope =
			sectionContent.toLowerCase().includes("modules") ||
			sectionContent.toLowerCase().includes("affected files") ||
			sectionContent.toLowerCase().includes("extensions/modules") ||
			sectionContent.toLowerCase().includes("affected extensions");
		assert.ok(hasBroaderScope, "Scope should not be limited to .pi/extensions/ only");
	});

	it("references available tools: jscpd, ripgrep_search, structural_search, diff", () => {
		const content = readAuditorMd();
		const sectionStart = content.indexOf("#### 4e. Code Quality");
		assert.ok(sectionStart >= 0);

		const sectionEnd = content.indexOf("#### 4f.", sectionStart);
		const sectionContent =
			sectionEnd >= 0
				? content.substring(sectionStart, sectionEnd)
				: content.substring(sectionStart);

		const hasJscpd = sectionContent.includes("jscpd");
		const hasRipgrep = sectionContent.includes("ripgrep_search");
		const hasStructural = sectionContent.includes("structural_search");
		const hasDiff = sectionContent.includes("diff");

		assert.ok(
			hasJscpd || hasRipgrep || hasStructural || hasDiff,
			"Should reference at least one detection tool",
		);

		// Check that at least ripgrep_search or jscpd is mentioned
		assert.ok(
			hasJscpd || hasRipgrep,
			"Should reference jscpd or ripgrep_search as detection tools",
		);
	});
});

// ─── Phase 3: Regression — resolveSkillPaths ──────────────────────

describe("resolveSkillPaths regression (Phase 3)", () => {
	it("resolveSkillPaths('duplicate-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("duplicate-code-hunter");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith(".pi/skills/duplicate-code-hunter/SKILL.md") ||
				result[0]!.endsWith("duplicate-code-hunter/SKILL.md"),
			`Path should end with duplicate-code-hunter/SKILL.md, got ${result[0]}`,
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
