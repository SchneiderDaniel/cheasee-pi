// ─── Tests: OctokitClient — getClosingPrsForIssue ───────────────
// Tests the implementation of closing-PR detection.
// Requires mocking the internal Octokit instance since it makes real
// GitHub API calls.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-client.test.mts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { OctokitClient } from "../../github/octokit-client.ts";

// ─── Mock Logger ──────────────────────────────────────────────────

function createMockLogger() {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => createMockLogger(),
	};
}

// ═══════════════════════════════════════════════════════════════════════
// getClosingPrsForIssue — search query construction
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.getClosingPrsForIssue", () => {
	it("correctly searches without state filter (open + merged PRs)", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		// Mock the internal octokit instance
		const searchMock = mock.fn((_opts: Record<string, unknown>) => ({
			data: { items: [] },
		}));
		(client as any).octokit = {
			search: {
				issuesAndPullRequests: searchMock,
			},
			pulls: {
				get: mock.fn(async () => {
					throw new Error("should not be called with empty results");
				}) as any,
			},
		};

		const result = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.equal(result.length, 0, "should return empty array for no results");
		assert.equal(searchMock.mock.callCount(), 1, "should call search once");

		// Verify the search query does NOT include 'is:open' filter
		const firstCall = searchMock.mock.calls[0];
		assert.ok(firstCall, "should have been called at least once");
		const rawArg = firstCall.arguments[0];
		assert.ok(rawArg, "should have query object as first arg");
		const searchQuery: string = (rawArg as { q: string }).q;
		assert.ok(typeof searchQuery === "string", "search query should be a string");
		assert.ok(searchQuery.includes("type:pr"), "query should include type:pr");
		assert.ok(!searchQuery.includes("is:open"), "query should NOT filter by is:open (needs merged PRs too)");
		assert.ok(searchQuery.includes("#42"), "query should include issue number");
	});

	it("classifies closing-keyword PR correctly", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		// Mock search to return one PR
		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => ({
					data: { items: [{ number: 1341 }] },
				})),
			},
			pulls: {
				get: mock.fn(async () => ({
					data: {
						number: 1341,
						merge_commit_sha: "8078920",
						merged_at: "2025-01-01T00:00:00Z",
						state: "closed",
						head: { ref: "main", sha: "8078920" },
						body: "This closes #42",
					},
				})),
			},
		};

		const result = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.equal(result.length, 1, "should find one PR");
		assert.equal(result[0].number, 1341, "should have PR number");
		assert.equal(result[0].sha, "8078920", "should have merge commit SHA");
		assert.equal(result[0].source, "closing-keyword", 'should be classified as closing-keyword');
		assert.equal(result[0].state, "merged", 'should be classified as merged');
	});

	it("classifies branch-head PR when body has no closing keywords", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => ({
					data: { items: [{ number: 1342 }] },
				})),
			},
			pulls: {
				get: mock.fn(async () => ({
					data: {
						number: 1342,
						merge_commit_sha: null,
						merged_at: null,
						state: "open",
						head: { ref: "fix-1289-branch", sha: "abc123" },
						body: "Some unrelated description without closing keywords",
					},
				})),
			},
		};

		const result = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.equal(result.length, 1, "should find one PR");
		assert.equal(result[0].number, 1342, "should have PR number");
		assert.equal(result[0].source, "branch-head", 'no closing keywords → branch-head');
		assert.equal(result[0].state, "open", 'should be open');
		assert.equal(result[0].branch, "fix-1289-branch", "should have branch name");
	});

	it("fail-open on API error returns empty array", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => {
					throw new Error("API rate limit exceeded");
				}),
			},
		};

		// Should not throw
		const result = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.equal(result.length, 0, "should return empty array on error");
	});

	it("includes PR details fetch failure gracefully", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => ({
					data: { items: [{ number: 42 }] },
				})),
			},
			pulls: {
				get: mock.fn(async () => {
					throw new Error("Not Found");
				}),
			},
		};

		// Should still return a PR ref even without details
		const result = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.equal(result.length, 1, "should still return the PR even if details fetch fails");
		assert.equal(result[0].number, 42, "should have PR number");
		assert.equal(result[0].sha, "", "sha should be empty");
		assert.equal(result[0].source, "branch-head", 'default source is branch-head');
		assert.equal(result[0].state, "open", 'default state is open');
	});

	it("invalid repo format throws", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);

		await assert.rejects(
			async () => await client.getClosingPrsForIssue(1, "invalid-repo"),
			/Invalid repo format/,
		);
	});
});
