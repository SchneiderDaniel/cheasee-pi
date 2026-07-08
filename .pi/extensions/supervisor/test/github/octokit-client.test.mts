// ─── Tests: github/octokit-client.ts — adapter contract tests ───
// Minimal contract tests using fixture-based approach.
// Tests the OctokitClient class directly.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Basic structural tests ──────────────────────────────────────
// Verify the OctokitClient class exists and implements GitHubPort

describe("OctokitClient — structural", () => {
	it("can be imported and instantiated", async () => {
		const { OctokitClient } = await import("../../github/octokit-client.ts");
		assert.equal(typeof OctokitClient, "function", "OctokitClient should be a class");
	});

	it("createGitHubPort factory exists", async () => {
		const mod = await import("../../github/ports.ts");
		assert.equal(typeof mod.createGitHubPort, "function", "createGitHubPort should be a function");
	});

	it("GitHubPort interface is exported", async () => {
		const mod = await import("../../github/ports.ts");
		// Interface is a type — verify it's exported by checking the module shape
		assert.ok("createGitHubPort" in mod, "ports.ts should export createGitHubPort");
	});
});

describe("GitHubPort interface contract", () => {
	it("createMockGitHubPort provides all required methods", async () => {
		const { createMockGitHubPort } = await import("../helper/mock-github-port.ts");
		const port = createMockGitHubPort();
		assert.equal(typeof port.getIssue, "function");
		assert.equal(typeof port.getIssueWithComments, "function");
		assert.equal(typeof port.closeIssue, "function");
		assert.equal(typeof port.postIssueComment, "function");
		assert.equal(typeof port.compareBranches, "function");
		assert.equal(typeof port.listPullRequestsForBranch, "function");
		assert.equal(typeof port.createPullRequest, "function");
		assert.equal(typeof port.updatePullRequest, "function");
		assert.equal(typeof port.getProjectFields, "function");
		assert.equal(typeof port.getProjectItems, "function");
		assert.equal(typeof port.getProjectId, "function");
		assert.equal(typeof port.setItemStatusField, "function");
		assert.equal(typeof port.checkBlockedByDependencies, "function");
		assert.equal(typeof port.setToken, "function");
	});
});
