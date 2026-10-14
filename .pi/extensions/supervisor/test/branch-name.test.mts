/**
 * Tests for supervisor/lib/branch-name.ts — the pure slug helper extracted out
 * of agent/task.ts so the pipeline modules no longer reach into the task
 * builder for it.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/branch-name.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { generateBranchName } from "../lib/branch-name.ts";
import { generateBranchName as taskGenerateBranchName } from "../agent/task.ts";

// ---------------------------------------------------------------------------
// Phase 5: branch-name extraction — identity + characterization parity
// ---------------------------------------------------------------------------

describe("branch-name — extraction (Phase 5)", () => {
	it("is the very same function the task builder re-exports", () => {
		assert.strictEqual(
			generateBranchName,
			taskGenerateBranchName,
			"agent/task.ts must re-export lib/branch-name.ts, not a copy",
		);
	});

	it("uses the default prefix when none is given", () => {
		assert.strictEqual(generateBranchName(1, "x"), "worktree-git-issue-1-x");
		assert.strictEqual(
			generateBranchName(42, "Fix bug"),
			"worktree-git-issue-42-fix-bug",
			"pre-move default-prefix output",
		);
	});

	it("accepts a custom prefix", () => {
		assert.strictEqual(generateBranchName(5, "test", "custom-"), "custom-5-test");
	});

	it("drops non-alphanumeric characters from the title", () => {
		assert.strictEqual(
			generateBranchName(7, "Title with SPECIAL chars!!!"),
			"worktree-git-issue-7-title-with-special-chars",
		);
	});

	it("truncates the slug to 50 characters before the prefix", () => {
		const result = generateBranchName(99, "A".repeat(100));
		const slug = result.replace(/^worktree-git-issue-\d+-/, "");
		assert.ok(slug.length <= 50, `slug length ${slug.length} exceeds 50: "${slug}"`);
	});
});
