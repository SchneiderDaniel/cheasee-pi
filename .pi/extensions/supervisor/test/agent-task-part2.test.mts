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
