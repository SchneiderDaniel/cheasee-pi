import assert from "node:assert";

import { describe, it } from "node:test";

import {
	generateBranchName,
	buildAgentTask,
	summarizeComments,
	hasDockerfileRelevance,
} from "../agent/task.ts";

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
