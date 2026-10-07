/**
 * Tests for Fix 1 of Issue #933:
 * - Fix 1: Remove worktree-sandbox from researcher.md extensions
 *
 * Phase 1: researcher.md — worktree-sandbox removed, other extensions preserved
 *
 * Fix 2 (absolute-path normalization of the extension-*-code-hunter skills) was
 * dropped: those skill files left the repo in commit 190394b8 ("moved"), so
 * there is no longer an asset to assert against.
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

