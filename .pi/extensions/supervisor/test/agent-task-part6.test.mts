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
