/**
 * Tests for extension-duplicate-code-hunter skill added to auditor agent.
 *
 * Phase 1: Skills frontmatter — verify private-pi skills removed from auditor
 * Phase 2: 4e Code Quality methodology instructions — verify detection references
 * Phase 3: Regression — existing resolveSkillPaths behavior unchanged
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-extension-duplicate-code-hunter.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { existsSync, readFileSync } from "node:fs";
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
	it("has no 'skills' field (private-pi skills removed)", () => {
		const content = readAuditorMd();
		assert.strictEqual(
			getFrontmatterField(content, "skills"),
			undefined,
			"frontmatter must not reference private-pi skills",
		);
	});
});

// ─── Phase 2: 4e Code Quality methodology instructions ────────────

describe("auditor.md — Code Quality duplicate detection (Phase 2)", () => {
	it("frontmatter has no skills field referencing private-pi skills", () => {
		const content = readAuditorMd();
		assert.strictEqual(
			getFrontmatterField(content, "skills"),
			undefined,
			"frontmatter must not reference private-pi skills",
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
		if (existsSync(resolve(process.cwd(), "private-pi", "skills", "extension-duplicate-code-hunter", "SKILL.md"))) {
			assert.equal(result.length, 1);
			assert.ok(
				result[0]!.endsWith("extension-duplicate-code-hunter/SKILL.md"),
				`Path should end with extension-duplicate-code-hunter/SKILL.md, got ${result[0]}`,
			);
		} else {
			assert.deepEqual(result, []); // private-pi clone absent → fail-open
		}
	});

	it("resolveSkillPaths('extension-spec') still resolves correctly (regression)", () => {
		const result = resolveSkillPaths("extension-spec");
		if (existsSync(resolve(process.cwd(), "private-pi", "skills", "extension-spec", "SKILL.md"))) {
			assert.equal(result.length, 1);
			assert.ok(
				result[0]!.endsWith("extension-spec/SKILL.md") || result[0]!.endsWith("extension-spec.md"),
			);
		} else {
			assert.deepEqual(result, []); // private-pi clone absent → fail-open
		}
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

	it("resolveSkillPaths('nonexistent-skill-xyz') does not throw — warns and skips (regression)", () => {
		const warnSpy = mock.method(console, "warn");
		try {
			const result = resolveSkillPaths("nonexistent-skill-xyz");
			assert.deepEqual(result, []);
		} finally {
			warnSpy.mock.restore();
		}
		assert.ok(warnSpy.mock.calls.length >= 1, "should warn for missing skill");
		assert.ok(
			String(warnSpy.mock.calls[0]?.arguments[0] ?? "").includes("nonexistent-skill-xyz"),
		);
	});
});
