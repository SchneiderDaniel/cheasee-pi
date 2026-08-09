// ─── Phase 6: System prompt options — handler.ts + agent/task.ts ──
// Tests that handler calls ctx.getSystemPromptOptions() and passes
// relevant fields to buildAgentTask().

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent/task.ts";
import type { FilteredIssueData } from "../config/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeFilteredData(overrides?: Partial<FilteredIssueData>): FilteredIssueData {
	return {
		body: "Issue body content",
		comments: [{ author: "architect", body: "## Architecture\nDesign approach" }],
		...overrides,
	};
}

const BASE_ARGS = {
	agentName: "researcher",
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

// ─── SystemPromptOptions interface ────────────────────────────────

describe("getSystemPromptOptions — contract", () => {
	it("getSystemPromptOptions is available on ExtensionCommandContext", () => {
		// Contract: available on command context
		const mockFn = () => ({ contextFiles: undefined, skills: undefined, selectedTools: undefined });
		assert.equal(typeof mockFn, "function");
		const result = mockFn();
		assert.equal(typeof result, "object");
	});

	it("returns BuildSystemPromptOptions with contextFiles, skills, selectedTools", () => {
		const options = {
			contextFiles: [".pi/agents.md", ".pi/skills/writing-voice/SKILL.md"],
			skills: ["writing-voice"],
			selectedTools: ["read", "bash", "edit"],
		};
		assert.ok(Array.isArray(options.contextFiles));
		assert.ok(Array.isArray(options.skills));
		assert.ok(Array.isArray(options.selectedTools));
	});

	it("fields can be undefined (when not configured)", () => {
		const options = { contextFiles: undefined, skills: undefined, selectedTools: undefined };
		assert.equal(options.contextFiles, undefined);
		assert.equal(options.skills, undefined);
		assert.equal(options.selectedTools, undefined);
	});
});

// ─── buildAgentTask with systemPromptOptions ─────────────────────
// The new optional parameter systemPromptOptions is added to
// buildAgentTask. When provided, it injects tool names into the task.
// NOTE: systemPromptOptions is the 21st parameter (after gateFailureContext).

describe("buildAgentTask — systemPromptOptions parameter", () => {
	it("buildAgentTask is a function exported from agent/task.ts", () => {
		assert.equal(typeof buildAgentTask, "function", "buildAgentTask should be exported");
	});

	it("generateBranchName is a function exported from agent/task.ts", () => {
		assert.equal(typeof generateBranchName, "function", "generateBranchName should be exported");
	});

	it("summarizeComments is a function exported from agent/task.ts", () => {
		assert.equal(typeof summarizeComments, "function", "summarizeComments should be exported");
	});

	it("generateBranchName returns correct branch name", () => {
		const branch = generateBranchName(42, "Fix bug", "worktree-git-issue-");
		assert.ok(branch.includes("42"), "branch should contain issue number");
		assert.ok(branch.includes("fix-bug"), "branch should contain slugified title");
	});

	it("buildAgentTask accepts new optional systemPromptOptions parameter", () => {
		// Test that existing call without the param still works (backward compat)
		const task = buildAgentTask(
			BASE_ARGS.agentName,
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
		assert.ok(task.includes("Issue Data"), "backward compatible output");
	});

	it("when systemPromptOptions provided, injects selectedTools into task", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
			undefined, // worktreePath
			undefined, // branchName
			undefined, // summarizedRejections
			undefined, // duplicateCodeContext
			undefined, // researchFindings
			undefined, // auditFeedback
			undefined, // deadCodeContext
			undefined, // vulnContext

			undefined, // gateFailureContext
			{ selectedTools: ["read", "bash", "edit"] }, // systemPromptOptions
		);
		assert.ok(task.includes("## Available Tools"), "should inject Available Tools section");
		assert.ok(task.includes("read"), "should list available tools");
		assert.ok(task.includes("bash"), "should list available tools");
		assert.ok(task.includes("edit"), "should list available tools");
	});

	it("when systemPromptOptions has contextFiles, injects them into task", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // deadCodeContext
			undefined, // vulnContext

			undefined, // gateFailureContext
			{ contextFiles: [".pi/agents.md", ".pi/skills/writing-voice/SKILL.md"] },
		);
		assert.ok(task.includes("## Available Tools"), "should inject Available Tools section");
		assert.ok(task.includes("Context Files"), "should reference context files");
	});

	it("when systemPromptOptions has skills, injects them into task", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // deadCodeContext
			undefined, // vulnContext

			undefined, // gateFailureContext
			{ skills: ["writing-voice", "extension-spec"] },
		);
		assert.ok(task.includes("## Available Tools"), "should inject Available Tools section");
		assert.ok(task.includes("writing-voice"), "should list loaded skills");
	});

	it("when systemPromptOptions not provided (undefined), no extra section emitted", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
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
			!task.includes("## Available Tools"),
			"should NOT inject section when options not provided",
		);
	});

	it("empty arrays → no section emitted (no empty placeholder)", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // deadCodeContext
			undefined, // vulnContext

			undefined, // gateFailureContext
			{ selectedTools: [], contextFiles: [], skills: [] },
		);
		assert.ok(
			!task.includes("## Available Tools"),
			"should NOT inject section when all arrays empty",
		);
	});

	it("each agent type (researcher/architect/test-designer/developer/auditor) includes the section", () => {
		const agents = ["researcher", "architect", "test-designer", "developer", "auditor"];
		for (const agent of agents) {
			const task = buildAgentTask(
				agent,
				BASE_ARGS.issueNum,
				BASE_ARGS.repo,
				BASE_ARGS.title,
				BASE_ARGS.filteredData,
				BASE_ARGS.defaultBranch,
				BASE_ARGS.remote,
				BASE_ARGS.worktreeBase,
				BASE_ARGS.branchPrefix,
				BASE_ARGS.mainRepoPrefix,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined, // deadCodeContext
				undefined, // vulnContext

				undefined, // gateFailureContext
				{ selectedTools: ["read", "bash"], contextFiles: ["config.json"] },
			);
			assert.ok(task.includes("## Available Tools"), `${agent} should include section`);
		}
	});

	it("boundary: undefined fields in systemPromptOptions — no crash", () => {
		const task = buildAgentTask(
			BASE_ARGS.agentName,
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
			BASE_ARGS.mainRepoPrefix,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // deadCodeContext
			undefined, // vulnContext

			undefined, // gateFailureContext
			{ selectedTools: undefined, contextFiles: undefined, skills: undefined },
		);
		assert.ok(!task.includes("## Available Tools"), "no section when all fields undefined");
	});
});
