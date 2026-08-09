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
	summarizeComments,
	hasDockerfileRelevance,
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
				"m",
				"o",
				"../",
				"p",
				"/test/main/repo",
			).includes("Follow your system prompt instructions"),
		);
	});

	it("hasDockerfileRelevance directly callable in assert", () => {
		assert.ok(hasDockerfileRelevance("install something", ""));
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

const BASE_ARGS = {
	agentName: "auditor",
	issueNum: 42,
	repo: "owner/repo",
	title: "Fix bug",
	filteredData: makeFilteredData(),
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../",
	branchPrefix: "worktree-git-issue-",
	mainRepoPrefix: "/test/main/repo",
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
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
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
		);
		assert.ok(task.includes("### Structured Output Format"), "Structured output heading present");
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext
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
			"## Audit Rejected\nCritical issue found", // auditFeedback
			undefined,
			undefined, // vulnContext
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
			undefined,
			undefined,
			"TDD gate failed",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output instruction present");
		assert.ok(task.includes("SECURITY RULE"), "SECURITY RULE section present");
	});
});

// ---------------------------------------------------------------------------
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			"## Audit Rejected\nCritical issue found", // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext
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
				body: "Remove dead export from extension test/file.ts",
			}),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			"/home/worktree", // worktreePath
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Dead Code Removal Task block present");
	});

	it("existing developer content unchanged regardless of dead-code match (no regression)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Dead code: remove foo",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
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

// ---------------------------------------------------------------------------
// Phase 10: Dockerfile awareness — trigger detection (hasDockerfileRelevance)
// ---------------------------------------------------------------------------

describe("hasDockerfileRelevance — trigger detection", () => {
	it("title 'Add gitleaks scanner' → true", () => {
		assert.ok(hasDockerfileRelevance("Add gitleaks scanner", ""));
	});

	it("title 'install python package' → true", () => {
		assert.ok(hasDockerfileRelevance("install python package", ""));
	});

	it("title 'dependency update required' → true", () => {
		assert.ok(hasDockerfileRelevance("dependency update required", ""));
	});

	it("title 'new CLI tool' → true", () => {
		assert.ok(hasDockerfileRelevance("new CLI tool", ""));
	});

	it("title 'npm audit fix' → true", () => {
		assert.ok(hasDockerfileRelevance("npm audit fix", ""));
	});

	it("title 'apt package needed' → true", () => {
		assert.ok(hasDockerfileRelevance("apt package needed", ""));
	});

	it("title 'pip install' → true", () => {
		assert.ok(hasDockerfileRelevance("pip install", ""));
	});

	it("title 'binary download' → true", () => {
		assert.ok(hasDockerfileRelevance("binary download", ""));
	});

	it("title 'Dockerfile update' → true", () => {
		assert.ok(hasDockerfileRelevance("Dockerfile update", ""));
	});

	it("title 'docker compose' → true", () => {
		assert.ok(hasDockerfileRelevance("docker compose", ""));
	});

	it("title 'Fix typo in README' → false", () => {
		assert.ok(!hasDockerfileRelevance("Fix typo in README", ""));
	});

	it("title 'refactor config parser' → false", () => {
		assert.ok(!hasDockerfileRelevance("refactor config parser", ""));
	});

	it("title 'rename variable' → false", () => {
		assert.ok(!hasDockerfileRelevance("rename variable", ""));
	});

	it("empty title + empty body → false", () => {
		assert.ok(!hasDockerfileRelevance("", ""));
	});

	it("body contains trigger word but title does not → true", () => {
		assert.ok(hasDockerfileRelevance("Fix bug", "Install the new tool"));
	});

	it("title contains trigger word but body is empty → true", () => {
		assert.ok(hasDockerfileRelevance("install", ""));
	});

	it("body contains 'gitleaks' → true", () => {
		assert.ok(hasDockerfileRelevance("Fix scanner", "Add gitleaks binary"));
	});

	it("body contains 'osv-scanner' → true", () => {
		assert.ok(hasDockerfileRelevance("Add scanner", "Install osv-scanner"));
	});

	it("single-word title 'install' → true", () => {
		assert.ok(hasDockerfileRelevance("install", ""));
	});

	it("boundary: 'installation-guide' → false (word boundary avoids false positive)", () => {
		assert.ok(!hasDockerfileRelevance("installation-guide", ""));
	});

	it("boundary: 'uninstall script' → false (word boundary avoids 'install' false positive)", () => {
		// "uninstall" = u-n-i-n-s-t-a-l-l. "install" starts at position 2.
		// Before "install" is 'n' (word char), so \b does NOT match.
		assert.ok(!hasDockerfileRelevance("uninstall script", ""));
	});
});

// ---------------------------------------------------------------------------
// Phase 11: Dockerfile awareness — instruction injection for developer agent
// ---------------------------------------------------------------------------

describe("buildAgentTask — Dockerfile awareness injection (developer)", () => {
	it("title 'Add gitleaks scanner' → task contains '### Dockerfile Awareness' heading", () => {
		const task = buildAgentTask(
			"developer",
			1123,
			"owner/repo",
			"Add gitleaks scanner",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			task.includes("### Dockerfile Awareness"),
			"Should contain Dockerfile Awareness heading",
		);
	});

	it("body mentioning 'npm install' → task contains docker/Dockerfile reference", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Add new dependency",
			makeFilteredData({ body: "npm install some-package" }),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("docker/Dockerfile"), "Should reference main Dockerfile");
		assert.ok(task.includes("### Dockerfile Awareness"), "Should contain heading");
	});

	it("title 'Add osv-scanner' → task mentions docker/Dockerfile by path", () => {
		const task = buildAgentTask(
			"developer",
			1122,
			"owner/repo",
			"Add osv-scanner",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("docker/Dockerfile"), "Mentions docker/Dockerfile");
	});

	it("title 'Fix typo in README' → does NOT contain '### Dockerfile Awareness'", () => {
		const task = buildAgentTask(
			"developer",
			999,
			"owner/repo",
			"Fix typo in README",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"Should NOT contain Dockerfile Awareness heading",
		);
	});

	it("instruction correctly maps pi-agent deps → docker/Dockerfile", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install new CLI tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		// The instruction should say Pi agent deps go in docker/Dockerfile
		assert.ok(task.includes("Pi agent dependencies"), "Should mention pi agent deps mapping");
		assert.ok(task.includes("docker/Dockerfile"), "Should mention docker/Dockerfile");
	});

	it("instruction mentions existing Dockerfile conventions", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Add npm package",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("pinned versions"), "Should mention pinned versions");
		assert.ok(task.includes("layer separation"), "Should mention layer separation");
		assert.ok(task.includes("apt cleanup"), "Should mention apt cleanup");
	});

	it("instruction appears BEFORE the structured output format section", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		const dockerfileIndex = task.indexOf("### Dockerfile Awareness");
		const jsonIndex = task.indexOf("### Structured Output Format");
		assert.ok(dockerfileIndex >= 0, "Dockerfile Awareness heading present");
		assert.ok(jsonIndex >= 0, "Structured Output Format heading present");
		assert.ok(
			dockerfileIndex < jsonIndex,
			"Dockerfile Awareness appears BEFORE Structured Output Format",
		);
	});

	it("instruction does NOT duplicate (only one block injected)", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		const matches = task.match(/### Dockerfile Awareness/g);
		assert.strictEqual(matches ? matches.length : 0, 1, "Only one Dockerfile Awareness heading");
	});
});

// ---------------------------------------------------------------------------
// Phase 12: Dockerfile awareness — no injection for other agents
// ---------------------------------------------------------------------------

describe("buildAgentTask — Dockerfile awareness NOT injected for other agents", () => {
	it("architect with 'Install python package' → no Dockerfile Awareness heading", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Install python package",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"Architect should NOT have Dockerfile Awareness",
		);
	});

	it("auditor with 'Add new dependency' → no Dockerfile Awareness heading", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Add new dependency",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"Auditor should NOT have Dockerfile Awareness",
		);
	});

	it("researcher with 'Add apt package' → no Dockerfile Awareness heading", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Add apt package",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"Researcher should NOT have Dockerfile Awareness",
		);
	});

	it("test-designer with 'Install tool' → no Dockerfile Awareness heading", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"Test-designer should NOT have Dockerfile Awareness",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 13: Dockerfile awareness — regression (existing content preserved)
// ---------------------------------------------------------------------------

describe("buildAgentTask — Dockerfile awareness regression (existing content preserved)", () => {
	it("developer with Dockerfile trigger still has JSON_OUTPUT_INSTRUCTION", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output instruction present");
		assert.ok(task.includes("SECURITY RULE"), "SECURITY RULE present");
	});

	it("developer with Dockerfile trigger still has resume-from-it instructions", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Add tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("git status"), "git status instruction present");
		assert.ok(task.includes("git stash list"), "git stash list instruction present");
		assert.ok(task.includes("resume from it"), "Resume instruction present");
	});

	it("developer with Dockerfile trigger still has thinking-effort instruction", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"pip install package",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("Thinking effort"), "Thinking effort instruction present");
	});

	it("developer with Dockerfile trigger still has example output", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"npm install pkg",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "Example output present");
		assert.ok(task.includes("Implemented the feature"), "Example output present");
	});

	it("developer with Dockerfile trigger still has generateBranchName in branch section", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("**Branch name:**"), "Branch name section present");
	});

	it("developer with Dockerfile trigger AND dead-code match — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Dead code: remove unused export",
			makeFilteredData({ body: "Install pip package" }),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes("## Dead Code Removal Task"), "Dead Code Removal Task block present");
		assert.ok(task.includes("### Dockerfile Awareness"), "Dockerfile Awareness block present");
	});

	it("developer with Dockerfile trigger AND gateFailureContext — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Install tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext
			"CI_FAILED: check build", // gateFailureContext
		);
		assert.ok(task.includes("<previous_gate_failure>"), "Gate failure block present");
		assert.ok(task.includes("### Dockerfile Awareness"), "Dockerfile Awareness block present");
	});

	it("developer with Dockerfile trigger AND auditFeedback — both blocks present", () => {
		const task = buildAgentTask(
			"developer",
			1124,
			"owner/repo",
			"Add CLI tool",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			"## Audit Rejected\nMissing Dockerfile update", // auditFeedback
			undefined, // deadCodeContext
			undefined, // gateFailureContext
		);
		assert.ok(
			task.includes("AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION"),
			"Audit feedback block present",
		);
		assert.ok(task.includes("### Dockerfile Awareness"), "Dockerfile Awareness block present");
	});

	it("existing developer task 'Fix bug' unchanged — no Dockerfile Awareness block", () => {
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
		);
		assert.ok(
			!task.includes("### Dockerfile Awareness"),
			"No Dockerfile Awareness for non-trigger title",
		);
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Existing content preserved",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 4 (issue #1473): rebaseConflictContext — "Reintegrate main" section
// ---------------------------------------------------------------------------

describe("buildAgentTask — rebaseConflictContext (Phase 4, Issue #1473)", () => {
	// Positional args up to gateFailureContext; rebaseConflictContext is the
	// appended 22nd parameter (regression guard for param ordering).
	function devTaskWithContext(context: string | null | undefined): string {
		return buildAgentTask(
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
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext
			undefined, // gateFailureContext
			undefined, // systemPromptOptions
			context, // rebaseConflictContext (new, appended last)
		);
	}

	it("developer with context — 'Reintegrate main' section present, every conflicted file listed verbatim", () => {
		const task = devTaskWithContext("src/a.ts\nsrc/b.ts\nsrc/c.ts");
		assert.ok(task.includes("### Reintegrate main"), "Section heading present");
		assert.ok(task.includes("- `src/a.ts`"), "First file listed verbatim");
		assert.ok(task.includes("- `src/b.ts`"), "Second file listed verbatim");
		assert.ok(task.includes("- `src/c.ts`"), "Third file listed verbatim");
		assert.ok(task.includes("3 file(s) conflicted"), "Conflict count rendered");
		assert.ok(task.indexOf("src/a.ts") < task.indexOf("src/c.ts"), "Files listed in given order");
	});

	it("developer with context — instructs git fetch <remote> <defaultBranch> and git merge <remote>/<defaultBranch>", () => {
		const task = devTaskWithContext("src/a.ts");
		assert.ok(task.includes("git fetch origin main"), "Fetch instruction present");
		assert.ok(task.includes("git merge origin/main"), "Merge instruction present");
		assert.ok(task.includes("git add -A"), "Stage step present (merge.ts devTask mirror)");
		assert.ok(
			task.includes("git commit -m"),
			"Commit-merge step present (merge.ts devTask mirror)",
		);
	});

	it("developer with context — no push instruction (pipeline owns push)", () => {
		const task = devTaskWithContext("src/a.ts");
		assert.ok(!task.includes("git push origin"), "No push command in conflict-path developer task");
		assert.ok(!task.includes("git push --force"), "No force-push instruction");
		assert.ok(task.includes("Do NOT run `git push`"), "Explicit keep-push-outside warning present");
	});

	it("context null/undefined — section absent; default developer task unchanged", () => {
		const withNull = devTaskWithContext(null);
		const withUndefined = devTaskWithContext(undefined);
		const withNoArg = devTaskWithContext(undefined as unknown as string);
		for (const task of [withNull, withUndefined, withNoArg]) {
			assert.ok(!task.includes("### Reintegrate main"), "No section when context absent");
			assert.ok(!task.includes("git merge origin/main"), "No merge instruction when absent");
		}
		// Default task (no context arg) byte-identical to pre-change rendering:
		// no extra section, existing blocks still present.
		assert.ok(withUndefined.includes("Work from current directory"), "Setup block intact");
		assert.ok(withUndefined.includes('"action": "COMPLETE"'), "JSON output intact");
	});

	it("section rendered only for developer — architect/test-designer/auditor/researcher never contain it even with context", () => {
		const args: [
			string,
			number,
			string,
			string,
			FilteredIssueData,
			string,
			string,
			string,
			string,
			string,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			string,
		] = [
			"x" as string,
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
			undefined,
			undefined,
			undefined,
			undefined,
			"src/a.ts",
		];
		for (const agentName of ["architect", "test-designer", "auditor", "researcher"]) {
			args[0] = agentName;
			const task = buildAgentTask(...args);
			assert.ok(!task.includes("### Reintegrate main"), `${agentName} must not get the section`);
			assert.ok(
				!task.includes("git merge origin/main"),
				`${agentName} must not get merge instructions`,
			);
		}
		// Sanity: same context on developer DOES render
		args[0] = "developer";
		assert.ok(
			buildAgentTask(...args).includes("### Reintegrate main"),
			"developer renders section",
		);
	});

	it("regression: prior args (gateFailureContext before systemPromptOptions) untouched by the appended param", () => {
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
			undefined,
			undefined,
			"GATE_FAILED: tsc",
			undefined,
			"src/a.ts",
		);
		// gateFailureContext still rendered
		assert.ok(task.includes("<previous_gate_failure>"), "gateFailureContext block intact");
		assert.ok(task.includes("GATE_FAILED: tsc"), "gateFailureContext content intact");
		// rebaseConflictContext also rendered
		assert.ok(task.includes("### Reintegrate main"), "rebaseConflictContext block rendered");
	});
});
