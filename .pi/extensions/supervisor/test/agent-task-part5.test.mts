import assert from "node:assert";

import { describe, it } from "node:test";

import { buildAgentTask, hasDockerfileRelevance } from "../agent/task.ts";

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

	it("body mentioning 'npm install' → task contains cmd/cheasee-pi/embedded/docker/Dockerfile reference", () => {
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
		assert.ok(
			task.includes("cmd/cheasee-pi/embedded/docker/Dockerfile"),
			"Should reference main Dockerfile",
		);
		assert.ok(task.includes("### Dockerfile Awareness"), "Should contain heading");
	});

	it("title 'Add osv-scanner' → task mentions cmd/cheasee-pi/embedded/docker/Dockerfile by path", () => {
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
		assert.ok(
			task.includes("cmd/cheasee-pi/embedded/docker/Dockerfile"),
			"Mentions cmd/cheasee-pi/embedded/docker/Dockerfile",
		);
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

	it("instruction correctly maps pi-agent deps → cmd/cheasee-pi/embedded/docker/Dockerfile", () => {
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
		// The instruction should say Pi agent deps go in cmd/cheasee-pi/embedded/docker/Dockerfile
		assert.ok(task.includes("Pi agent dependencies"), "Should mention pi agent deps mapping");
		assert.ok(
			task.includes("cmd/cheasee-pi/embedded/docker/Dockerfile"),
			"Should mention cmd/cheasee-pi/embedded/docker/Dockerfile",
		);
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
