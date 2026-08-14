/**
 * Verify ranked_map extension removal:
 * - ranked-map directory no longer exists
 * - No ranked_map / rankedMap references remain in source files
 * - settings.json has no rankedMap config block
 * - APPEND_SYSTEM.md uses ripgrep_search / structural_search guidance
 *
 * This test must FAIL when the removal is reverted (TDD gate verification).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RANKED_MAP_DIR = join(ROOT, ".pi/extensions/ranked-map");
const SETTINGS_PATH = join(ROOT, ".pi/settings.json");
// Tool-routing guidance now lives in the global append (installed as
// ~/.pi/agent/APPEND_SYSTEM.md) — the AGENTS.md split (#1517).
const APPEND_SYSTEM_MD_PATH = join(ROOT, "APPEND_SYSTEM.md");
const AGENTS_MD_PATH = join(ROOT, "AGENTS.md");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");

// Source files that were modified during the ranked_map removal
const MODIFIED_FILES = [
	".pi/extensions/ripgrep-search/internal.ts",
	".pi/extensions/ripgrep-search/index.ts",
	".pi/extensions/supervisor/lib/shared-prompts.ts",
	".pi/extensions/agent-harness/lib/harness-rules.ts",
];

const MODIFIED_MD_FILES = [
	".pi/extensions/supervisor/agents/architect.md",
	".pi/extensions/supervisor/agents/auditor.md",
	".pi/extensions/supervisor/agents/developer.md",
	".pi/extensions/supervisor/agents/test-designer.md",
	".pi/skills/architecture-review/SKILL.md",
];

// Live scan of .pi/skills/<name>/SKILL.md so future prompt→skill migrations
// do not break this guard again (broke twice: ced0750, #1433). Depth-1 only:
// ponytail-* aliases may chain outside the repo on a clean checkout, so skip
// unresolvable paths rather than fail on them.
function listSkillFiles(): string[] {
	const skillsDir = join(ROOT, ".pi/skills");
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() || e.isSymbolicLink())
		.map((e) => join(skillsDir, e.name, "SKILL.md"))
		.filter((p) => existsSync(p));
}

describe("ranked_map extension removal", () => {
	// ─── Phase 1: Directory removal ───────────────────────────────────

	describe("Phase 1: ranked-map directory removed", () => {
		it("ranked-map directory no longer exists", () => {
			assert.ok(
				!existsSync(RANKED_MAP_DIR),
				`ranked-map directory still exists at ${RANKED_MAP_DIR}`,
			);
		});
	});

	// ─── Phase 2: Settings.json config removed ─────────────────────────

	describe("Phase 2: rankedMap config removed from settings.json", () => {
		it("settings.json exists", () => {
			assert.ok(existsSync(SETTINGS_PATH), `settings.json not found at ${SETTINGS_PATH}`);
		});

		it("settings.json is valid JSON", () => {
			const raw = readFileSync(SETTINGS_PATH, "utf-8");
			assert.doesNotThrow(() => JSON.parse(raw), "settings.json is not valid JSON");
		});

		it("settings.json has no rankedMap key at any nesting level", () => {
			const raw = readFileSync(SETTINGS_PATH, "utf-8");
			assert.ok(!raw.includes("rankedMap"), "settings.json still contains 'rankedMap' key");
		});
	});

	// ─── Phase 3: APPEND_SYSTEM.md references removed ────────────────

	describe("Phase 3: APPEND_SYSTEM.md updated", () => {
		it("APPEND_SYSTEM.md exists", () => {
			assert.ok(
				existsSync(APPEND_SYSTEM_MD_PATH),
				`APPEND_SYSTEM.md not found at ${APPEND_SYSTEM_MD_PATH}`,
			);
		});

		it("APPEND_SYSTEM.md does not mention ranked_map", () => {
			const content = readFileSync(APPEND_SYSTEM_MD_PATH, "utf-8");
			assert.ok(
				!content.includes("ranked_map"),
				"APPEND_SYSTEM.md still references 'ranked_map'",
			);
		});

		it("APPEND_SYSTEM.md mentions ripgrep_search for literal text", () => {
			const content = readFileSync(APPEND_SYSTEM_MD_PATH, "utf-8");
			assert.ok(
				content.includes("ripgrep_search"),
				"APPEND_SYSTEM.md should mention ripgrep_search for literal text search",
			);
		});

		it("APPEND_SYSTEM.md mentions structural_search for AST patterns", () => {
			const content = readFileSync(APPEND_SYSTEM_MD_PATH, "utf-8");
			assert.ok(
				content.includes("structural_search"),
				"APPEND_SYSTEM.md should mention structural_search for AST pattern matching",
			);
		});

		it("AGENTS.md stub does not mention ranked_map", () => {
			const content = readFileSync(AGENTS_MD_PATH, "utf-8");
			assert.ok(!content.includes("ranked_map"), "AGENTS.md stub still references 'ranked_map'");
		});
	});

	// ─── Phase 4: Source files no longer reference ranked_map ──────────

	describe("Phase 4: Source files updated (no ranked_map / rankedMap references)", () => {
		for (const relPath of MODIFIED_FILES) {
			it(`${relPath} does not mention 'ranked_map'`, () => {
				const absPath = join(ROOT, relPath);
				assert.ok(existsSync(absPath), `${relPath} not found`);
				const content = readFileSync(absPath, "utf-8");
				assert.ok(!content.includes("ranked_map"), `${relPath} still references 'ranked_map'`);
			});
		}

		it("package.json test script does not reference old ranked-map extension test files", () => {
			const content = readFileSync(PACKAGE_JSON_PATH, "utf-8");
			const oldRefs = [
				".pi/extensions/ranked-map/test/",
				"ranked-map/test/expand.test",
				"ranked-map/test/scoring.test",
			];
			for (const ref of oldRefs) {
				assert.ok(
					!content.includes(ref),
					`package.json test script still references old ranked-map test file: ${ref}`,
				);
			}
		});
	});

	// ─── Phase 5: Supervisor agent markdown files updated ──────────────

	describe("Phase 5: Agent markdown files updated", () => {
		for (const relPath of MODIFIED_MD_FILES) {
			it(`${relPath} does not mention 'ranked_map'`, () => {
				const absPath = join(ROOT, relPath);
				assert.ok(existsSync(absPath), `${relPath} not found`);
				const content = readFileSync(absPath, "utf-8");
				assert.ok(!content.includes("ranked_map"), `${relPath} still references 'ranked_map'`);
			});
		}

		it("all skill files do not mention 'ranked_map'", () => {
			for (const absPath of listSkillFiles()) {
				const content = readFileSync(absPath, "utf-8");
				assert.ok(!content.includes("ranked_map"), `${absPath} still references 'ranked_map'`);
			}
		});
	});

	// ─── Phase 6: Verify key replacements are correct ──────────────────

	describe("Phase 6: Key replacements verified", () => {
		it("ripgrep-search/internal.ts uses structural_search in error messages", () => {
			const content = readFileSync(
				join(ROOT, ".pi/extensions/ripgrep-search/internal.ts"),
				"utf-8",
			);
			// Error messages should mention structural_search for class/def/function patterns
			assert.ok(
				content.includes("Use structural_search (ast-grep) to find class definitions"),
				"class def error should mention structural_search",
			);
			assert.ok(
				content.includes("Use structural_search (ast-grep) to find function definitions"),
				"function def error should mention structural_search",
			);
		});

		it("shared-prompts.ts uses ripgrep_search + structural_search guidance", () => {
			const content = readFileSync(
				join(ROOT, ".pi/extensions/supervisor/lib/shared-prompts.ts"),
				"utf-8",
			);
			assert.ok(content.includes("ripgrep_search"), "shared-prompts should mention ripgrep_search");
			assert.ok(
				content.includes("structural_search"),
				"shared-prompts should mention structural_search",
			);
		});
	});
});
