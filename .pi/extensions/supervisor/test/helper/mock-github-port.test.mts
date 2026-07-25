// ─── Tests: helper/mock-github-port.ts — mock GitHubPort ─────────
// Verifies the 8-method contract: each method exists, returns correct
// defaults, respects overrides, and records calls when trackCalls is
// provided.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubPort, type PortCall } from "./mock-github-port.ts";

describe("createMockGitHubPort — port method contract", () => {
	it("returns an object with all port methods", () => {
		const port = createMockGitHubPort();
		assert.equal(typeof port.postIssueComment, "function");
		assert.equal(typeof port.getProjectFields, "function");
		assert.equal(typeof port.getProjectItems, "function");
		assert.equal(typeof port.getProjectId, "function");
		assert.equal(typeof port.setItemStatusField, "function");
		assert.equal(typeof port.checkBlockedByDependencies, "function");
		assert.equal(typeof port.createPullRequest, "function");
		assert.equal(typeof port.listPullRequestsForBranch, "function");
		assert.equal(typeof port.getClosingPrsForIssue, "function");
		assert.equal(typeof port.setToken, "function");
	});

	it("postIssueComment returns void by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.postIssueComment(1, "owner/repo", "hello");
		assert.equal(result, undefined);
	});

	it("getProjectFields returns [] by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.getProjectFields(1);
		assert.deepEqual(result, []);
	});

	it("getProjectItems returns [] by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.getProjectItems(1);
		assert.deepEqual(result, []);
	});

	it("getProjectId returns '' by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.getProjectId(1);
		assert.equal(result, "");
	});

	it("setItemStatusField returns void by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.setItemStatusField("a", "b", "c", "d");
		assert.equal(result, undefined);
	});

	it("checkBlockedByDependencies returns { blocked: false } by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.checkBlockedByDependencies(1, "owner/repo");
		assert.deepEqual(result, { blocked: false, blockers: [] });
	});

	it("createPullRequest returns { number: 123 } by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.createPullRequest({
			repo: "owner/repo",
			base: "main",
			head: "branch",
			title: "test",
		});
		assert.deepEqual(result, { number: 123 });
	});

	it("listPullRequestsForBranch returns null by default", async () => {
		const port = createMockGitHubPort();
		const result = await port.listPullRequestsForBranch("branch", "owner/repo");
		assert.equal(result, null);
	});

	it("tracks calls when trackCalls is provided", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(undefined, calls);
		await port.postIssueComment(1, "r", "b");
		await port.getProjectFields(2);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].method, "postIssueComment");
		assert.deepEqual(calls[0].args, [1, "r", "b"]);
		assert.equal(calls[1].method, "getProjectFields");
		assert.deepEqual(calls[1].args, [2]);
	});

	it("respects per-method overrides", async () => {
		const port = createMockGitHubPort({
			getProjectFields: async () => [{ id: "f1", name: "Status", type: "SingleSelect", options: [{ id: "o1", name: "Done" }] }],
		});
		const fields = await port.getProjectFields(1);
		assert.equal(fields.length, 1);
		assert.equal(fields[0].name, "Status");
	});

	it("tracks calls even when methods are overridden", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({
			getProjectFields: async () => [{ id: "f1", name: "Status", type: "SingleSelect" }],
		}, calls);
		await port.getProjectFields(1);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "getProjectFields");
	});
});
