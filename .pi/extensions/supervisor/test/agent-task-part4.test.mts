import assert from "node:assert";

import { describe, it } from "node:test";

import { buildAgentTask } from "../agent/task.ts";

import type { FilteredIssueData } from "../config/types.ts";

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
