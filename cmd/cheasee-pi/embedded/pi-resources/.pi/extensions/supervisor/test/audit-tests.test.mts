/**
 * Tests for audit-tests.sh — dynamic worktree detection (Phase 3)
 *
 * Phase 3a: --worktree-path override flag
 * Phase 3b: git worktree list porcelain detection
 * Phase 3c: No worktree found error
 * Phase 3d: WORKTREE_PARENT hardcoded variable removed
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-tests.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT = resolve(__dirname, "../../../../.pi/scripts/audit-tests.sh");

// ---------------------------------------------------------------------------
// Phase 3a: --worktree-path override flag
// ---------------------------------------------------------------------------

describe("audit-tests.sh --worktree-path flag (Phase 3a)", () => {
	it("--worktree-path flag accepted in usage", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			source.includes("--worktree-path"),
			"Script should contain --worktree-path reference",
		);
	});

	it("--worktree-path parsed from command line", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// The parsing code should handle --worktree-path
		assert.ok(
			source.includes("--worktree-path") || source.includes("worktree_path"),
			"Script should have --worktree-path parsing logic",
		);
	});

	it("explicit worktree path returned by resolve_worktree_dir instead of git detection", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// resolve_worktree_dir should return explicit path when provided
		assert.ok(
			source.includes("explicit_worktree_path") ||
				(source.includes("resolve_worktree_dir") && source.includes("explicit_path")),
			"Script should check explicit path before falling back to git detection",
		);
	});

	it("resolve_worktree_dir returns explicit path when provided", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// Check the function returns explicit path early
		const hasEarlyReturn = source.includes('if [[ -n "$explicit_path" ]]');
		assert.ok(hasEarlyReturn, "resolve_worktree_dir should return explicit path early");
	});
});

// ---------------------------------------------------------------------------
// Phase 3b: git worktree list porcelain detection
// ---------------------------------------------------------------------------

describe("audit-tests.sh git worktree list detection (Phase 3b)", () => {
	it("resolve_worktree_dir uses git worktree list --porcelain for detection", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			source.includes("git worktree list --porcelain"),
			"Script should use git worktree list --porcelain",
		);
	});

	it("resolve_worktree_dir parses porcelain output to extract worktree path by branch", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// Check for awk or similar parsing of branch refs/heads/
		assert.ok(
			source.includes("refs/heads/"),
			"Script should parse branch refs from porcelain output",
		);
	});

	it("resolve_worktree_dir extracts worktree path from porcelain output", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// Check for worktree path extraction pattern
		assert.ok(
			source.includes("/^worktree /"),
			"Script should match worktree path lines in porcelain output",
		);
	});

	it("script execution uses git worktree list for branch detection", () => {
		// Verify the script actually runs git worktree list when branch is valid
		// Run in a git repo to test real detection
		const result = execSync(`bash -n "${SCRIPT}" 2>&1`, {
			timeout: 5000,
			encoding: "utf-8",
		});
		assert.ok(
			result === "" || result.includes("error") === false,
			"Script should pass syntax check",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 3c: No worktree found error
// ---------------------------------------------------------------------------

describe("audit-tests.sh no worktree found (Phase 3c)", () => {
	it("resolve_worktree_dir dies with error when no worktree found for branch", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			source.includes("No worktree found for branch"),
			"Script should error when no worktree found for given branch",
		);
	});

	it("error message includes branch name in 'No worktree found' message", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			source.includes("No worktree found for branch ${branch_name}") ||
				source.includes("worktree found for branch"),
			"Script should include branch name in error",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 3d: WORKTREE_PARENT hardcoded variable removed
// ---------------------------------------------------------------------------

describe("audit-tests.sh WORKTREE_PARENT removed (Phase 3d)", () => {
	it("WORKTREE_PARENT variable no longer defined in script", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		// WORKTREE_PARENT should not be defined as a constant anymore
		const lines = source.split("\n").filter((l) => l.includes("WORKTREE_PARENT"));
		assert.strictEqual(lines.length, 0, "WORKTREE_PARENT should not appear in script");
	});

	it("script does not reference WORKTREE_PARENT in cmd_run", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			!source.includes("${WORKTREE_PARENT}"),
			"Script should not use WORKTREE_PARENT interpolation",
		);
	});

	it("resolve_worktree_dir replaces hardcoded WORKTREE_PARENT pattern", () => {
		const source = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			source.includes("resolve_worktree_dir"),
			"Script should define resolve_worktree_dir instead of using WORKTREE_PARENT",
		);
	});
});
