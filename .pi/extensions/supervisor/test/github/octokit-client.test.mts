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

// ═══════════════════════════════════════════════════════════════════════
// postIssueComment — escape normalization safety net (regression #1663)
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.postIssueComment", () => {
	function mockedClient(createCommentMock: ReturnType<typeof mock.fn>): OctokitClient {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = {
			issues: { createComment: createCommentMock },
		};
		return client;
	}

	it("normalizes literal \\n escapes so markdown headers render (regression #1663)", async () => {
		const createCommentMock = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = mockedClient(createCommentMock);

		await client.postIssueComment(
			42,
			"owner/repo",
			"## Audit Rejected\\n\\n### Findings\\n\\n1. **Correctness & Safety**\\n   - **Symptom:** x",
		);

		assert.equal(createCommentMock.mock.callCount(), 1);
		const args = createCommentMock.mock.calls[0]!.arguments[0] as {
			body: string;
		};
		assert.ok(
			args.body.includes("\n\n### Findings\n\n1."),
			"escaped \\n sequences must become real newlines",
		);
		assert.ok(!args.body.includes("\\n"), "no literal \\n escapes may remain in posted body");
		assert.ok(args.body.startsWith("## Audit Rejected\n"), "markdown header must render");
	});

	it("leaves real newlines untouched", async () => {
		const createCommentMock = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = mockedClient(createCommentMock);

		await client.postIssueComment(42, "owner/repo", "## Audit Approved\n\n### Summary\nok");

		const args = createCommentMock.mock.calls[0]!.arguments[0] as { body: string };
		assert.equal(args.body, "## Audit Approved\n\n### Summary\nok");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// getIssue / getIssueWithComments — 404 interpretation (issue #1893)
// The "not found" definition is a single predicate; both methods must agree.
// Exercised only through the public methods (isNotFound stays unexported).
// ═══════════════════════════════════════════════════════════════════════

const MOCK_ISSUE = { number: 42, title: "Title", body: "Body", user: { login: "alice" } };

function clientWithIssues(issues: Record<string, unknown>): OctokitClient {
	const client = new OctokitClient("fake-token", createMockLogger() as any);
	(client as any).octokit = { issues };
	return client;
}

// Values the client must interpret as "not found".
const NOT_FOUND_ERRORS: unknown[] = [
	{ status: 404 },
	Object.assign(new Error("Not Found"), { status: 404 }),
];

// Values the client must rethrow untouched.
const OTHER_ERRORS: unknown[] = [
	{ status: 500 },
	{ status: 403 },
	{ status: "404" }, // string, not number — strict === 404
	new Error("boom"),
	"boom", // non-object throw
	null, // null is not instanceof Object
];

describe("OctokitClient.getIssue — 404 interpretation", () => {
	it("resolves null for 404-shaped errors", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const client = clientWithIssues({ get: mock.fn(async () => {
				throw err;
			}) });
			assert.equal(
				await client.getIssue(1, "owner/repo"),
				null,
				`should resolve null for ${JSON.stringify(err)}`,
			);
		}
	});

	it("rethrows every non-404 error unchanged", async () => {
		for (const err of OTHER_ERRORS) {
			const client = clientWithIssues({ get: mock.fn(async () => {
				throw err;
			}) });
			await assert.rejects(
				() => client.getIssue(1, "owner/repo"),
				(e: unknown) => e === err,
				`should rethrow the exact value for ${String(err)}`,
			);
		}
	});

	it("maps issue data on the happy path", async () => {
		const client = clientWithIssues({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		assert.deepEqual(await client.getIssue(1, "owner/repo"), {
			number: 42,
			title: "Title",
			body: "Body",
			author: { login: "alice" },
		});
	});

	it("normalizes falsy title/body and missing user to undefined", async () => {
		const client = clientWithIssues({
			get: mock.fn(async () => ({ data: { number: 7, title: "", body: null } })),
		});
		assert.deepEqual(await client.getIssue(1, "owner/repo"), {
			number: 7,
			title: undefined,
			body: undefined,
			author: undefined,
		});
	});

	it("invalid repo format throws before any request", async () => {
		const get = mock.fn(async () => ({ data: MOCK_ISSUE }));
		const client = clientWithIssues({ get });
		await assert.rejects(() => client.getIssue(1, "invalid"), /Invalid repo format/);
		assert.equal(get.mock.callCount(), 0, "must not call the API for an invalid repo");
	});
});

describe("OctokitClient.getIssueWithComments — 404 interpretation", () => {
	it("resolves null for 404-shaped errors from either call", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const issueClient = clientWithIssues({
				get: mock.fn(async () => ({ data: MOCK_ISSUE })),
				listComments: mock.fn(async () => {
					throw err;
				}),
			});
			assert.equal(
				await issueClient.getIssueWithComments(1, "owner/repo"),
				null,
				`listComments 404 (${JSON.stringify(err)}) → null`,
			);

			const commentClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			assert.equal(
				await commentClient.getIssueWithComments(1, "owner/repo"),
				null,
				`issues.get 404 (${JSON.stringify(err)}) → null`,
			);
		}
	});

	it("rethrows every non-404 error unchanged", async () => {
		for (const err of OTHER_ERRORS) {
			const client = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			await assert.rejects(
				() => client.getIssueWithComments(1, "owner/repo"),
				(e: unknown) => e === err,
			);
		}
	});

	it("maps issue + comments on the happy path", async () => {
		const client = clientWithIssues({
			get: mock.fn(async () => ({ data: MOCK_ISSUE })),
			listComments: mock.fn(async () => ({
				data: [{ user: { login: "bob" }, body: "hi" }, { body: "" }],
			})),
		});
		assert.deepEqual(await client.getIssueWithComments(1, "owner/repo"), {
			number: 42,
			title: "Title",
			body: "Body",
			author: { login: "alice" },
			comments: [
				{ author: { login: "bob" }, body: "hi", id: undefined },
				{ author: undefined, body: undefined, id: undefined },
			],
		});
	});

	it("invalid repo format throws", async () => {
		const client = clientWithIssues({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		await assert.rejects(() => client.getIssueWithComments(1, "invalid"), /Invalid repo format/);
	});
});

describe("OctokitClient — cross-method 404 symmetry (issue #1893)", () => {
	it("getIssue and getIssueWithComments never disagree about 'not found'", async () => {
		for (const err of [...NOT_FOUND_ERRORS, ...OTHER_ERRORS]) {
			const issueClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			const commentClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			const outcome = async (p: Promise<unknown>): Promise<string> => {
				try {
					await p;
					return "resolved";
				} catch {
					return "rejected";
				}
			};
			assert.equal(
				await outcome(issueClient.getIssue(1, "owner/repo")),
				await outcome(commentClient.getIssueWithComments(1, "owner/repo")),
				`methods disagreed about ${String(err)}`,
			);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// issue #2044 — in-place comment update + label CRUD
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.updateIssueComment (issue #2044)", () => {
	it("dispatches a numeric id to the REST updateComment endpoint", async () => {
		const updateComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { updateComment } };

		await client.updateIssueComment("123456", "owner/repo", "## Audit Rejected\nx");

		assert.equal(updateComment.mock.callCount(), 1);
		const params = updateComment.mock.calls[0]!.arguments[0] as {
			comment_id: number;
			body: string;
		};
		assert.equal(params.comment_id, 123456);
		assert.equal(params.body, "## Audit Rejected\nx");
	});

	it("dispatches an opaque node id to the GraphQL updateIssueComment mutation", async () => {
		const graphqlMock = mock.fn(async (_q: string) => ({ updateIssueComment: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { updateComment: mock.fn() } };
		(client as any)._graphql = graphqlMock;

		await client.updateIssueComment("IC_kwDOabc", "owner/repo", "## Audit Rejected\nx");

		assert.equal(graphqlMock.mock.callCount(), 1);
		const query = graphqlMock.mock.calls[0]!.arguments[0] as string;
		assert.ok(query.includes("updateIssueComment"), "must use the updateIssueComment mutation");
		assert.ok(query.includes("IC_kwDOabc"), "must carry the comment node id");
	});

	it("invalid repo format throws", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		await assert.rejects(
			() => client.updateIssueComment("1", "invalid", "x"),
			/Invalid repo format/,
		);
	});
});

describe("OctokitClient label CRUD (issue #2044)", () => {
	it("getIssueLabels returns label names", async () => {
		const listLabelsOnIssue = mock.fn(async (_params: Record<string, unknown>) => ({
			data: [{ name: "reject-1" }, { name: "bug" }],
		}));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { listLabelsOnIssue } };

		assert.deepEqual(await client.getIssueLabels(42, "owner/repo"), ["reject-1", "bug"]);
	});

	it("getIssueLabels paginates until a short page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
		const listLabelsOnIssue = mock.fn(async (params: Record<string, unknown>) =>
			(params as { page: number }).page === 1 ? { data: fullPage } : { data: [{ name: "tail" }] },
		);
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { listLabelsOnIssue } };

		const labels = await client.getIssueLabels(42, "owner/repo");
		assert.equal(labels.length, 101);
		assert.equal(labels[100], "tail");
		assert.equal(listLabelsOnIssue.mock.callCount(), 2);
	});

	it("addIssueLabel adds without replacing existing labels", async () => {
		const addLabels = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { addLabels } };

		await client.addIssueLabel(42, "owner/repo", "reject-2");
		const params = addLabels.mock.calls[0]!.arguments[0] as { labels: string[] };
		assert.deepEqual(params.labels, ["reject-2"]);
	});

	it("removeIssueLabel tolerates a missing label (404)", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("Label does not exist"), { status: 404 });
		});
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { removeLabel } };

		await client.removeIssueLabel(42, "owner/repo", "reject-1");
		assert.equal(removeLabel.mock.callCount(), 1);
	});

	it("removeIssueLabel rethrows non-404 errors", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("forbidden"), { status: 403 });
		});
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { removeLabel } };

		await assert.rejects(() => client.removeIssueLabel(42, "owner/repo", "reject-1"), /forbidden/);
	});
});
