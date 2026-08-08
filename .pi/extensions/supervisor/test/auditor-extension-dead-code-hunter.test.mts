/**
 * Tests for extension-dead-code-hunter skill added to auditor agent.
 *
 * Phase 1: Skills frontmatter — verify private-pi skills removed from auditor
 * Phase 2: Regression — existing resolveSkillPaths behavior unchanged
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-extension-dead-code-hunter.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkillPaths, resolveSkillPathsWithFs } from "../lib/extensions.ts";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent/task.ts";
import type { FilteredIssueData } from "../config/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDITOR_MD = resolve(__dirname, "../agents/auditor.md");

// These skills live in the maintainer's host-side private-pi clone
// (`../private-pi/skills`), which is absent on fresh clones — fail-open then.
function privatePiSkill(name: string): boolean {
	return existsSync(resolve(process.cwd(), "private-pi", "skills", name, "SKILL.md"));
}

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

// ─── Phase 2: Regression — resolveSkillPaths ──────────────────────

describe("resolveSkillPaths regression (Phase 2)", () => {
	it("resolveSkillPaths('extension-duplicate-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("extension-duplicate-code-hunter");
		if (privatePiSkill("extension-duplicate-code-hunter")) {
			assert.equal(result.length, 1);
			assert.ok(
				result[0]!.endsWith("extension-duplicate-code-hunter/SKILL.md"),
				`Path should end with extension-duplicate-code-hunter/SKILL.md, got ${result[0]}`,
			);
		} else {
			assert.deepEqual(result, []); // private-pi clone absent → fail-open
		}
	});

	it("resolveSkillPaths('extension-dead-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("extension-dead-code-hunter");
		if (privatePiSkill("extension-dead-code-hunter")) {
			assert.equal(result.length, 1);
			assert.ok(
				result[0]!.endsWith("extension-dead-code-hunter/SKILL.md"),
				`Path should end with extension-dead-code-hunter/SKILL.md, got ${result[0]}`,
			);
		} else {
			assert.deepEqual(result, []); // private-pi clone absent → fail-open
		}
	});

	it("resolveSkillPaths('extension-spec') still resolves correctly (regression)", () => {
		const result = resolveSkillPaths("extension-spec");
		if (privatePiSkill("extension-spec")) {
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

// ─── Helpers for Phase 3 ────────────────────────────────────────────

function makeFilteredData(overrides?: Partial<FilteredIssueData>): FilteredIssueData {
	return {
		body: "Issue body content",
		comments: [
			{ author: "architect", body: "## Architecture\nDesign approach" },
			{ author: "designer", body: "## Test Plan\nTest approach" },
		],
		...overrides,
	};
}

const DEAD_CODE_CONTEXT =
	"**1 dead code finding(s) found (1 total lines)**\n\n#1: `src/a.ts` line 10:1 — **unused-export** `unusedFunc` (confidence: 100%)";

// ─── Phase 3: buildAgentTask dead code context for auditor ───────────

describe("buildAgentTask — deadCodeContext (Phase 3)", () => {
	it("auditor with deadCodeContext → task contains Dead Code Detected heading", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			DEAD_CODE_CONTEXT,
		);
		assert.ok(
			task.includes("### ⚠️ Dead Code Detected (Pre-Audit Gate)"),
			"Should contain dead code detected heading",
		);
		assert.ok(
			task.includes("1 dead code finding(s) found"),
			"Should contain dead code finding summary from context",
		);
	});

	it("auditor without deadCodeContext (undefined) → no dead code block", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("⚠️ Dead Code Detected"),
			"Should NOT contain dead code block when no context given",
		);
	});

	it("auditor with deadCodeContext null → no dead code block", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			null,
		);
		assert.ok(
			!task.includes("⚠️ Dead Code Detected"),
			"Should NOT contain dead code block when context is null",
		);
	});

	it("developer with deadCodeContext → irrelevant, no dead code block", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			DEAD_CODE_CONTEXT,
		);
		assert.ok(
			!task.includes("⚠️ Dead Code Detected"),
			"Developer task should NOT have dead code block",
		);
	});

	it("auditor task includes audit checklist with dead code item", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			task.includes("Dead code: ← verify findings from pre-audit gate or run ripgrep_search"),
			"Auditor task checklist should include dead code line",
		);
	});

	it("auditor example JSON shows total: 10 (was 9, now +1 for dead code)", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		// Find example JSON for approved flow with auditScore
		const approvedSection = task.substring(
			task.indexOf('"action": "APPROVED"'),
			task.indexOf('"action": "REJECTED"'),
		);
		assert.ok(
			approvedSection.includes('"total": 10'),
			"Auditor approved example JSON should show total: 10",
		);
	});

	it("auditor with deadCodeContext contains formatted finding context", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			DEAD_CODE_CONTEXT,
		);
		assert.ok(task.includes("unused-export"), "Should contain the type from dead code context");
		assert.ok(task.includes("unusedFunc"), "Should contain the symbol from dead code context");
		assert.ok(task.includes("src/a.ts"), "Should contain the file from dead code context");
	});

	// ═════════════════════════════════════════════════════════════════
	// Agent/task.ts symbol coverage (inline assertion lines)
	// TDD gate requires exported symbols to appear on the same line
	// as an assertion pattern (assert.ok, assert.equal, etc.).
	// ═════════════════════════════════════════════════════════════════

	describe("agent/task.ts — inline symbol coverage", () => {
		it("generateBranchName inline in assertion line", () => {
			assert.equal(generateBranchName(1, "Hello World", "worktree-"), "worktree-1-hello-world");
		});

		it("generateBranchName handles special chars", () => {
			assert.equal(
				generateBranchName(638, "Wire extension-dead-code-hunter into pipeline", "prefix-"),
				"prefix-638-wire-extension-dead-code-hunter-into-pipeline",
			);
		});

		it("generateBranchName uses default prefix", () => {
			assert.ok(generateBranchName(42, "Test issue").startsWith("worktree-git-issue-42-test"));
		});

		it("summarizeComments inline in assertion line", () => {
			const result = summarizeComments([{ author: "user1", body: "Comment 1" }]);
			assert.ok(result.includes("Comment 1"));
		});

		it("summarizeComments returns fallback for empty", () => {
			assert.equal(summarizeComments([]), "(no trusted comments)");
		});

		it("buildAgentTask inline in assertion line for auditor", () => {
			assert.ok(
				buildAgentTask(
					"auditor",
					42,
					"owner/repo",
					"Fix bug",
					makeFilteredData(),
					"main",
					"origin",
					"../",
					"worktree-git-issue-",
					"/test/main/repo",
				).includes("### Structured Output Format"),
			);
		});

		it("buildAgentTask inline for developer without dead code block", () => {
			assert.ok(
				!buildAgentTask(
					"developer",
					42,
					"owner/repo",
					"Fix bug",
					makeFilteredData(),
					"main",
					"origin",
					"../",
					"worktree-git-issue-",
					"/test/main/repo",
				).includes("### ⚠️ Dead Code"),
			);
		});
	});
});
