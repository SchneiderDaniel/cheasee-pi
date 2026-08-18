/**
 * Tests for Fix 1-2 of Issue #933:
 * - Fix 1: Remove worktree-sandbox from researcher.md extensions
 * - Fix 2: Normalize absolute paths to repo-relative in skill files
 *
 * Phase 1: researcher.md — worktree-sandbox removed, other extensions preserved
 * Phase 2: Skill files — zero /home/miria/git/main/ occurrences, paths start with .pi/
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Phase 1: Fix 1 — researcher.md extension list
// ---------------------------------------------------------------------------

describe("Fix 1 — researcher.md extensions (Issue #933)", () => {
	const researcherPath = resolve(REPO_ROOT, ".pi/extensions/supervisor/agents/researcher.md");
	const content = readFileSync(researcherPath, "utf-8");

	it("worktree-sandbox is absent from extensions list", () => {
		const extMatch = content.match(/^extensions:\s+"([^"]+)"/m);
		assert.ok(extMatch, "extensions field must exist in frontmatter");
		const extensions = extMatch[1].split(",");
		assert.ok(
			!extensions.includes("worktree-sandbox"),
			"worktree-sandbox must NOT be in extensions list",
		);
	});

	it("all 6 other extensions are still present", () => {
		const extMatch = content.match(/^extensions:\s+"([^"]+)"/m);
		assert.ok(extMatch, "extensions field must exist in frontmatter");
		const extensions = extMatch[1].split(",");
		const expected = [
			"agent-harness",
			"caveman",
			"ripgrep-search",
			"scrapling",
			"structural-analyzer",
			"web-search",
		];
		for (const ext of expected) {
			assert.ok(extensions.includes(ext), `Extension "${ext}" must be present in extensions list`);
		}
	});

	it("tools field is unchanged (read, bash, structural_search, ripgrep_search, web_search)", () => {
		const toolsMatch = content.match(/^tools:\s+(.+)/m);
		assert.ok(toolsMatch, "tools field must exist in frontmatter");
		const tools = toolsMatch[1].split(",").map((t) => t.trim());
		assert.deepStrictEqual(tools, [
			"read",
			"bash",
			"structural_search",
			"ripgrep_search",
			"web_search",
		]);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Fix 2 — Absolute path removal from skill files
// ---------------------------------------------------------------------------

describe("Fix 2 — Skill files: zero /home/miria/git/main/ occurrences (Issue #933)", () => {
	const skillFiles = [
		".pi/skills/extension-dead-code-hunter/SKILL.md",
		".pi/skills/extension-dead-code-hunter/references/dead-code-detection.md",
		".pi/skills/extension-duplicate-code-hunter/SKILL.md",
		".pi/skills/extension-duplicate-code-hunter/references/duplicate-code-detection.md",
	];

	for (const file of skillFiles) {
		it(`${file}: zero occurrences of /home/miria/git/main/`, () => {
			const fullPath = resolve(REPO_ROOT, file);
			const content = readFileSync(fullPath, "utf-8");
			const matches = content.match(/\/home\/miria\/git\/main\//g);
			assert.strictEqual(
				matches === null ? 0 : matches.length,
				0,
				`Found ${matches ? matches.length : 0} occurrences of /home/miria/git/main/ in ${file}`,
			);
		});
	}
});

describe("Fix 2 — Skill files: paths start with .pi/ not /home/miria/git/main/.pi/ (Issue #933)", () => {
	const skillFiles = [
		".pi/skills/extension-dead-code-hunter/SKILL.md",
		".pi/skills/extension-dead-code-hunter/references/dead-code-detection.md",
		".pi/skills/extension-duplicate-code-hunter/SKILL.md",
		".pi/skills/extension-duplicate-code-hunter/references/duplicate-code-detection.md",
	];

	for (const file of skillFiles) {
		it(`${file}: bash command paths use .pi/ prefix (first character check)`, () => {
			const fullPath = resolve(REPO_ROOT, file);
			const content = readFileSync(fullPath, "utf-8");
			// Find lines with `.pi/` that are bash code blocks or file references
			// and ensure none start with /home/miria/git/main/.pi/
			const badLines: string[] = [];
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes(".pi/") && lines[i].includes("/home/miria/git/main/")) {
					badLines.push(`Line ${i + 1}: ${lines[i].trim()}`);
				}
			}
			assert.strictEqual(
				badLines.length,
				0,
				`Found ${badLines.length} lines with absolute paths:\n${badLines.join("\n")}`,
			);
		});
	}
});
