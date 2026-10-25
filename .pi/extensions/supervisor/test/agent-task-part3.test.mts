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
describe("buildAgentTask — success example omits refusal (Issue #1618)", () => {
	it("JSON_OUTPUT_INSTRUCTION success example has no refusal key and requires omitting it", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Design",
			makeFilteredData(),
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		// Regression (audit): the success JSON example once contained a
		// `refusal` placeholder. With presence-based refusal detection, an
		// agent copying the example literally (or emitting `refusal: ""`
		// alongside a success action) was classified as RefusedOutput and
		// stopped the pipeline. Only the example may not reference the key.
		assert.ok(!/"refusal"\s*:/.test(task), "success example must not include a refusal key");
		assert.ok(
			task.includes("Omit `refusal` unless you cannot complete the task"),
			"template must tell agents to omit refusal unless refusing",
		);
	});
});
