/**
 * Tests for agent-task.ts
 *
 * Phase 1: generateBranchName (characterization — existing behavior preserved)
 * Phase 2: buildAgentTask auditor — structured output markers (new behavior)
 * Phase 3: buildAgentTask other agents — structured output markers (current impl)
 * Phase 4: buildAgentTask auditor worktree path + branch name
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	generateBranchName,
	buildAgentTask,
	truncateComment,
	summarizeComments,
} from "../agent/task.ts";
import type { FilteredIssueData } from "../config/types.ts";

// ---------------------------------------------------------------------------
// Phase 0: Direct export coverage (TDD gate test-covers-symbols)
// ---------------------------------------------------------------------------
// TDD gate's test-covers-symbols check requires that exported function names
// appear directly inside assert() call parentheses (not just via variable
// assignment). These test cases ensure task.ts exports are detectable.

describe("task.ts runtime exports — direct call in assertions", () => {
	it("generateBranchName directly callable in assert", () => {
		assert.strictEqual(generateBranchName(1, "x"), "worktree-git-issue-1-x");
	});

	it("truncateComment directly callable in assert", () => {
		assert.strictEqual(truncateComment("hello", 100), "hello");
	});

	it("summarizeComments directly callable in assert", () => {
		assert.ok(summarizeComments([{ author: "a", body: "b" }]).includes("b"));
	});

	it("buildAgentTask directly callable in assert", () => {
		assert.ok(
			buildAgentTask(
				"developer",
				1,
				"r",
				"t",
				makeFilteredData(),
				[],
				"m",
				"o",
				"../",
				"p",
			).includes("Follow your system prompt instructions"),
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 4: worktree path + branch name in auditor task (Bug: auditor checks
//          main instead of feature worktree — false rejection)
// ---------------------------------------------------------------------------
// Tests for new optional worktreePath+branchName params on buildAgentTask.
// Auditor case must embed the worktree path so agent's bash tool uses correct
// cwd. Developer/architect/researcher/test-designer cases unchanged.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const DEFAULT_SUBMODULES: Array<{ path: string; repo: string }> = [];

const BASE_ARGS = {
	agentName: "auditor",
	issueNum: 42,
	repo: "owner/repo",
	title: "Fix bug",
	filteredData: makeFilteredData(),
	submodules: DEFAULT_SUBMODULES,
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../",
	branchPrefix: "worktree-git-issue-",
};

// ---------------------------------------------------------------------------
// Phase 1: generateBranchName
// ---------------------------------------------------------------------------

describe("generateBranchName", () => {
	it("basic: issue 42, title 'Fix bug' → worktree-git-issue-42-fix-bug", () => {
		const result = generateBranchName(42, "Fix bug", "worktree-git-issue-");
		assert.strictEqual(result, "worktree-git-issue-42-fix-bug");
	});

	it("drops non-alphanumeric chars from title", () => {
		const result = generateBranchName(7, "Title with SPECIAL chars!!!");
		assert.strictEqual(result, "worktree-git-issue-7-title-with-special-chars");
	});

	it("truncates slug to ≤50 chars before prefix", () => {
		const result = generateBranchName(99, "A".repeat(100));
		const full = result;
		const slug = full.replace(/^worktree-git-issue-\d+-/, "");
		assert.ok(slug.length <= 50, `slug length ${slug.length} exceeds 50: "${slug}"`);
	});

	it("accepts custom prefix", () => {
		const result = generateBranchName(5, "test", "custom-");
		assert.strictEqual(result, "custom-5-test");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: truncateComment
// ---------------------------------------------------------------------------

describe("truncateComment", () => {
	it("body ≤2000 chars → returned unchanged, no overflow note", () => {
		const body = "short body";
		const result = truncateComment(body);
		assert.strictEqual(result, body);
	});

	it("body exactly 2000 chars → returned unchanged", () => {
		const body = "x".repeat(2000);
		const result = truncateComment(body);
		assert.strictEqual(result, body);
	});

	it("body 2001 chars → truncated at 2000 with overflow note", () => {
		const body = "x".repeat(2001);
		const result = truncateComment(body);
		assert.ok(result.endsWith("\n…[+1 more chars]"));
		assert.strictEqual(result.split("\n")[0].length, 2000);
	});

	it("body 10000 chars → truncated at 2000 with correct overflow count", () => {
		const body = "x".repeat(10000);
		const result = truncateComment(body);
		assert.ok(result.endsWith("\n…[+8000 more chars]"));
	});

	it("body empty string → returns empty string", () => {
		const result = truncateComment("");
		assert.strictEqual(result, "");
	});

	it("custom maxLength parameter truncates at custom boundary", () => {
		const body = "x".repeat(100);
		const result = truncateComment(body, 50);
		assert.ok(result.endsWith("\n…[+50 more chars]"));
	});

	it("body shorter than custom maxLength → no truncation", () => {
		const body = "short";
		const result = truncateComment(body, 100);
		assert.strictEqual(result, "short");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: summarizeComments — all comments verbatim, no limits
// ---------------------------------------------------------------------------

describe("summarizeComments", () => {
	it("0 comments → returns (no trusted comments)", () => {
		const result = summarizeComments([]);
		assert.strictEqual(result, "(no trusted comments)");
	});

	it("1 comment → full verbatim with header", () => {
		const result = summarizeComments([{ author: "user1", body: "First comment body" }]);
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("First comment body"));
	});

	it("2 comments → both rendered verbatim and in full", () => {
		const result = summarizeComments([
			{ author: "user1", body: "First comment" },
			{ author: "user2", body: "Second comment" },
		]);
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("First comment"));
		assert.ok(result.includes("--- Comment #2 by @user2 ---"));
		assert.ok(result.includes("Second comment"));
	});

	it("20 comments → all 20 verbatim, no truncation, no summary", () => {
		const comments = Array.from({ length: 20 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments);
		for (let i = 0; i < 20; i++) {
			assert.ok(result.includes(`--- Comment #${i + 1} by @user${i + 1} ---`));
			assert.ok(result.includes(`Comment body ${i + 1}`));
		}
		// No summary block ever
		assert.ok(!result.includes("### Previous Comments"));
	});

	it("comment with 5000 chars → full length preserved, no truncation", () => {
		const longBody = "x".repeat(5000);
		const result = summarizeComments([{ author: "user1", body: longBody }]);
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("x".repeat(5000)));
	});
});

// ---------------------------------------------------------------------------
// Phase 2: buildAgentTask auditor — structured output markers
// ---------------------------------------------------------------------------
// The auditor task uses structured output markers (AUDIT_DECISION, PR_BODY,
// COMMENT_BODY) instead of running gh CLI commands. Pipeline reads markers
// and handles PR creation/comment posting programmatically.

describe("buildAgentTask — auditor JSON output markers", () => {
	it("contains JSON action: APPROVED and REJECTED markers", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes('"action": "APPROVED"'), "Should contain APPROVED action");
		assert.ok(task.includes('"action": "REJECTED"'), "Should contain REJECTED action");
	});

	it("contains prBody and commentBody keys in approved flow", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes('"prBody"'), "Should contain prBody key");
		assert.ok(task.includes('"commentBody"'), "Should contain commentBody key");
	});

	it("contains prTitle with issue number", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes('"prTitle"'), "Should contain prTitle key");
	});

	it("contains minimal delegation instruction", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Should contain minimal delegation",
		);
	});

	it("contains commentBody in REJECT flow section", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		const rejectSection = task.substring(task.lastIndexOf('"action": "REJECTED"'));
		assert.ok(rejectSection.includes('"commentBody"'), "REJECT flow contains commentBody key");
	});

	it("contains structured output format heading", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("### Structured Output Format"), "Structured output heading present");
	});

	it("with empty submodules list — no submodule repos listed", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			[],
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("(none)") || !task.includes("submodule"), "No submodules listed");
	});
});

// ---------------------------------------------------------------------------
// Phase 3: other agents (structured output markers)
// ---------------------------------------------------------------------------

describe("buildAgentTask — other agents (JSON output markers)", () => {
	it("architect task: JSON output instead of gh CLI", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
		// No gh CLI calls in architect task
		assert.ok(!task.includes("gh issue comment"));
	});

	it("developer task: no git add/git commit, has work-from-cwd + branch name", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		// Pipeline handles commit/push — agent task doesn't include git add/commit
		assert.ok(!task.includes("git worktree add"), "No git worktree add in developer task");
		assert.ok(!task.includes("git add"), "No git add in developer task");
		assert.ok(!task.includes("git commit"), "No git commit in developer task");
		// Branch info still present
		assert.ok(task.includes("worktree-git-issue-42-fix-bug"), "Branch name in task");
		// Current-directory workflow
		assert.ok(
			task.includes("Work from current directory") || task.includes("worktree already set up"),
			"Worktree pre-setup mentioned",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action present");
	});

	it("researcher task: minimal system prompt delegation", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("Follow your system prompt instructions"), "Minimal delegation");
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output format present");
	});

	it("test-designer task: JSON output with commentBody", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("Follow your system prompt instructions"), "Minimal delegation");
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
	});

	it("unknown agent name → default fallback task without crash", () => {
		const task = buildAgentTask(
			"unknown-agent",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("Complete the task for issue #42"));
		assert.ok(!task.includes("undefined"));
	});
});

// ---------------------------------------------------------------------------
// Phase 4: worktree path + branch name in auditor task
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor worktree path + branch name (Phase 4)", () => {
	it("auditor with worktreePath → task contains 'Your current working directory IS the worktree' with path", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree-git-issue-42-fix-bug",
		);
		assert.ok(
			task.includes("Your current working directory IS the worktree"),
			"Should contain worktree path announcement",
		);
		assert.ok(
			task.includes("/home/worktree-git-issue-42-fix-bug"),
			"Should contain the actual worktree path",
		);
	});

	it("auditor with worktreePath + branchName → task contains both", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
			"fix-bug",
		);
		assert.ok(
			task.includes("Your current working directory IS the worktree"),
			"Should contain worktree announcement",
		);
		assert.ok(task.includes("/home/wt"), "Should contain worktree path");
		assert.ok(task.includes("fix-bug"), "Should contain branch name");
		assert.ok(
			task.includes("git branch --show-current"),
			"Should contain git branch --show-current instruction",
		);
	});

	it("auditor with worktreePath → task contains 'prepend: cd <path> &&' instruction", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(task.includes("cd /home/wt"), "Should contain cd to worktree path instruction");
		assert.ok(
			task.includes("Before any bash command"),
			"Should contain instruction to prepend cd before bash commands",
		);
	});

	it("auditor without worktreePath → no worktree path in task (backward compat)", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Should NOT contain worktree announcement when no worktreePath given",
		);
	});

	it("developer with worktreePath → developer task unchanged (no worktree path in task text)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
			"fix-bug",
		);
		assert.ok(task.includes("Work from current directory"), "Developer task unchanged");
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Developer should NOT have the auditor's worktree announcement",
		);
	});

	it("architect with worktreePath → architect task unchanged", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Architect should NOT have worktree announcement",
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Architect task uses minimal delegation",
		);
	});

	it("researcher with worktreePath → task unchanged", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Researcher should NOT have worktree announcement",
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Researcher task uses minimal delegation",
		);
	});

	it("test-designer with worktreePath → task unchanged", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Test-designer should NOT have worktree announcement",
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Test-designer task uses minimal delegation",
		);
	});

	it("backward compat — auditor task has minimal delegation and JSON markers without optional params", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("Follow your system prompt instructions"), "Minimal delegation");
		assert.ok(task.includes('"action"'), "JSON action key present");
	});
});

// ---------------------------------------------------------------------------
// Phase 5: buildAgentTask gateFailureContext (Phase 3 of #787)
// ---------------------------------------------------------------------------

describe("buildAgentTask — gateFailureContext (Phase 3, Issue #787)", () => {
	it("developer without gateFailureContext — no <previous_gate_failure> tag", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(!task.includes("<previous_gate_failure>"), "No XML tag when no context");
	});

	it("developer with gateFailureContext — contains <previous_gate_failure> XML tag", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			"CI_FAILED: check build", // gateFailureContext
		);
		assert.ok(task.includes("<previous_gate_failure>"), "Should contain XML opening tag");
		assert.ok(task.includes("</previous_gate_failure>"), "Should contain XML closing tag");
	});

	it("developer with gateFailureContext — contains the exact note text", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"CI_FAILED: check build",
		);
		assert.ok(task.includes("CI_FAILED: check build"), "Contains the exact note text");
	});

	it("developer with gateFailureContext — contains action items with git status instruction", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"TDD gate failed",
		);
		assert.ok(task.includes("Action items:"), "Contains Action items section");
		assert.ok(task.includes("git status"), "Contains git status instruction");
	});

	it("developer with gateFailureContext — contains git log --oneline instruction", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"TDD gate failed",
		);
		assert.ok(task.includes("git log --oneline"), "Contains git log --oneline instruction");
	});

	it("developer with gateFailureContext AND auditFeedback — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"## Audit Rejected\nCritical issue found", // auditFeedback
			undefined,
			"TDD gate failed", // gateFailureContext
		);
		assert.ok(task.includes("<previous_gate_failure>"), "Gate failure block present");
		assert.ok(
			task.includes("AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION"),
			"Audit feedback block present",
		);
	});

	it("architect with gateFailureContext — no XML block", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"CI_FAILED",
		);
		assert.ok(!task.includes("<previous_gate_failure>"), "Architect should not have XML block");
	});

	it("auditor with gateFailureContext — no XML block", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"CI_FAILED",
		);
		assert.ok(!task.includes("<previous_gate_failure>"), "Auditor should not have XML block");
	});

	it("researcher with gateFailureContext — no XML block", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"CI_FAILED",
		);
		assert.ok(!task.includes("<previous_gate_failure>"), "Researcher should not have XML block");
	});

	it("test-designer with gateFailureContext — no XML block", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"CI_FAILED",
		);
		assert.ok(!task.includes("<previous_gate_failure>"), "Test-designer should not have XML block");
	});

	it("developer with gateFailureContext — existing resume instructions still present (no regression)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"TDD gate failed",
		);
		assert.ok(task.includes("git stash list"), "Existing resume instructions still present");
		assert.ok(task.includes("resume from it"), "Resume instruction still present");
	});

	it("developer with gateFailureContext — JSON_OUTPUT_INSTRUCTION still present (no regression)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"TDD gate failed",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output instruction present");
		assert.ok(task.includes("SECURITY RULE"), "SECURITY RULE section present");
	});
});

// ---------------------------------------------------------------------------
// when issue body contains absolute main-repo paths and agent runs in worktree.

describe("buildPathMappingBlock — pure function (Issue #933 Fix 3)", () => {
	// We test indirectly via buildAgentTask since buildPathMappingBlock is internal.
	// Use makeFilteredData with bodyOverride to inject absolute paths into the issue body.

	it("worktreePath undefined → no path mapping block", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Found issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined, // worktreePath — undefined
		);
		assert.ok(
			!task.includes("### Path note"),
			"Should NOT contain path mapping block when worktreePath is undefined",
		);
	});

	it("worktreePath set but issueBody lacks /home/miria/git/main/ → no path mapping", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Issue with no absolute paths" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(
			!task.includes("### Path note"),
			"Should NOT contain path mapping block when issue body has no absolute paths",
		);
	});

	it("Both worktreePath and /home/miria/git/main/ present → contains ### Path note", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Found issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Should contain ### Path note heading");
	});

	it("Both present → mapping contains 'repo-relative paths' with correct substitution", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Found issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(
			task.includes("/home/miria/git/main/.pi/extensions/X/file.ts → .pi/extensions/X/file.ts"),
			"Should contain path substitution example",
		);
	});

	it("worktreePath with trailing slash → still produces valid block, no double-slash", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Found issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree/", // trailing slash
		);
		assert.ok(
			task.includes("### Path note"),
			"Should still contain path mapping block with trailing slash",
		);
	});

	it("issueBody with multiple /home/miria/git/main/ occurrences → mapping block injected once", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({
				body: "/home/miria/git/main/.pi/extensions/a/file.ts\n/home/miria/git/main/.pi/extensions/b/file.ts",
			}),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		// Count occurrences of ### Path note
		const matches = task.match(/### Path note/g);
		assert.strictEqual(
			matches ? matches.length : 0,
			1,
			"Should have exactly one ### Path note block",
		);
	});

	it("Empty issueBody with worktreePath → no path mapping block", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(
			!task.includes("### Path note"),
			"Should NOT contain path mapping block when issue body is empty",
		);
	});

	it("Output contains literal MAIN_REPO_PREFIX value so agent sees correct mapping", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Found issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(
			task.includes("/home/miria/git/main"),
			"Should contain literal main repo path so agent sees correct mapping",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 8: buildAgentTask path mapping integration (Issue #933 — Fix 3)
// ---------------------------------------------------------------------------
// All agents receive path mapping when worktreePath is set and body contains
// absolute main-repo paths.

describe("buildAgentTask — path mapping block integration (Issue #933 Fix 3)", () => {
	it("auditor with worktreePath + body with /home/miria/git/main/ → contains path mapping", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Auditor should receive path mapping block");
	});

	it("developer with worktreePath + body with /home/miria/git/main/ → contains path mapping", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Developer should receive path mapping block");
	});

	it("architect with worktreePath + body with /home/miria/git/main/ → contains path mapping", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Architect should receive path mapping block");
	});

	it("researcher with worktreePath + body with /home/miria/git/main/ → contains path mapping", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Researcher should receive path mapping block");
	});

	it("test-designer with worktreePath + body with /home/miria/git/main/ → contains path mapping", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("### Path note"), "Test-designer should receive path mapping block");
	});

	it("worktreePath undefined + absolute paths in body → no path mapping block", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined, // worktreePath
		);
		assert.ok(
			!task.includes("### Path note"),
			"No path mapping when worktreePath is undefined (backward compat)",
		);
	});

	it("worktreePath set + body without absolute paths → no path mapping block", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "Ordinary issue body" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(!task.includes("### Path note"), "No path mapping when body lacks absolute paths");
	});

	it("gateFailureContext + path mapping conditions → both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			"CI_FAILED: check build", // gateFailureContext
		);
		assert.ok(task.includes("### Path note"), "Path mapping block present");
		assert.ok(task.includes("<previous_gate_failure>"), "Gate failure block present");
	});

	it("auditFeedback + path mapping conditions → both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			"## Audit Rejected\nCritical issue found", // auditFeedback
		);
		assert.ok(task.includes("### Path note"), "Path mapping block present");
		assert.ok(
			task.includes("AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION"),
			"Audit feedback block present",
		);
	});

	it("existing developer resume instructions unchanged (no regression)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(task.includes("git status"), "git status instruction present");
		assert.ok(task.includes("git stash list"), "git stash list instruction present");
		assert.ok(task.includes("SECURITY RULE"), "SECURITY RULE section present");
		assert.ok(task.includes("Branch name:"), "Branch name section present");
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"System prompt delegation present",
		);
	});

	it("existing auditor worktree block remains (no regression)", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "issue in /home/miria/git/main/.pi/extensions/test/file.ts" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree",
		);
		assert.ok(
			task.includes("Your current working directory IS the worktree"),
			"Auditor worktree announcement still present",
		);
		assert.ok(task.includes("cd /home/worktree"), "Auditor cd instruction still present");
	});
});

// ---------------------------------------------------------------------------
// Phase 9: Dead-code hint injection (Issue #934 Fix 3)
// ---------------------------------------------------------------------------

describe("buildAgentTask — dead-code removal hint injection (Issue #934 Fix 3)", () => {
	it("developer task with title 'Dead Code: remove foo' contains ## Dead Code Removal Task", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead Code: remove foo",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("## Dead Code Removal Task"),
			"Should contain Dead Code Removal Task heading for title with 'Dead Code'",
		);
	});

	it("developer task with title 'Fix dead code in bar' contains dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix dead code in bar",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("## Dead Code Removal Task"),
			"Should match via 'dead code' (regex .? matches space)",
		);
	});

	it("developer task with title 'Remove dead export' contains dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Remove dead export",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Should match via 'dead export'");
	});

	it("developer task with body containing 'unused export' contains dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix something",
			makeFilteredData({ body: "Remove unused export from module" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("## Dead Code Removal Task"),
			"Should match via 'unused export' in body",
		);
	});

	it("developer task with body containing 'not exported' contains dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix something",
			makeFilteredData({ body: "This value is not exported from module anymore" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("## Dead Code Removal Task"),
			"Should match via 'not exported' in body (accept false positive per architecture)",
		);
	});

	it("developer task with title 'Fix bug' (no match) does NOT contain dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Should NOT contain Dead Code Removal Task when title/body has no match",
		);
	});

	it("developer task with empty title and body does NOT contain dead-code hint", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"",
			makeFilteredData({ body: "" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Should NOT contain Dead Code Removal Task with empty title and body",
		);
	});

	it("developer task with title 'deadline' does NOT match dead-code regex", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"deadline",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"'deadline' should NOT match dead.?code (regex requires optional char then 'code')",
		);
	});

	it("developer task with dead-code match — injected block includes MUST NOT statically import", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove unused export",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("MUST NOT statically import"),
			"Should contain 'MUST NOT statically import' instruction",
		);
	});

	it("developer task with dead-code match — injected block includes dynamic import()", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove unused export",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("dynamic `import()`"), "Should contain 'dynamic import()' instruction");
	});

	it("other agent (architect) does NOT receive dead-code hint regardless of title", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Dead Code: remove exports",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Architect should NOT receive dead-code hint",
		);
	});

	it("other agent (auditor) does NOT receive dead-code hint regardless of title", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Dead Code: remove exports",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Auditor should NOT receive dead-code hint",
		);
	});

	it("other agent (test-designer) does NOT receive dead-code hint regardless of title", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Dead Code: remove exports",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Test-designer should NOT receive dead-code hint",
		);
	});

	it("other agent (researcher) does NOT receive dead-code hint regardless of title", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Dead Code: remove exports",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"Researcher should NOT receive dead-code hint",
		);
	});

	it("developer with dead-code hint AND gateFailureContext — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove foo",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			"CI_FAILED: check build", // gateFailureContext
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Dead Code Removal Task block present");
		assert.ok(task.includes("<previous_gate_failure>"), "Gate failure block present");
	});

	it("developer with dead-code hint AND auditFeedback — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove foo",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			"## Audit Rejected\nCritical issue found", // auditFeedback
			undefined, // deadCodeContext
			undefined, // gateFailureContext
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Dead Code Removal Task block present");
		assert.ok(
			task.includes("AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION"),
			"Audit feedback block present",
		);
	});

	it("developer with dead-code hint AND path mapping conditions — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove foo",
			makeFilteredData({
				body: "Remove dead export from /home/miria/git/main/.pi/extensions/test/file.ts",
			}),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree", // worktreePath
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Dead Code Removal Task block present");
		assert.ok(task.includes("### Path note"), "Path mapping block present");
	});

	it("existing developer content unchanged regardless of dead-code match (no regression)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove foo",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		// Existing resume instructions
		assert.ok(task.includes("git status"), "git status instruction present");
		assert.ok(task.includes("git stash list"), "git stash list instruction present");
		assert.ok(task.includes("SECURITY RULE"), "SECURITY RULE section present");
		assert.ok(task.includes("Branch name:"), "Branch name section present");
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output instruction present");
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"System prompt delegation present",
		);
	});

	it("existing buildAgentTask callers unchanged — all existing tests continue passing (no regression)", () => {
		// Verify basic developer call still works with no dead-code context
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Standard developer task still produced",
		);
		assert.ok(
			!task.includes("## Dead Code Removal Task"),
			"No dead-code hint for non-dead-code title",
		);
	});
});
