// ─── Tests: github/octokit-pulls.ts (issue #2098) ────────────────
// Phase 3 — PR + dependency contract unchanged by the God-Object split.
// The two known defects are characterized as-is and NOT fixed here:
//   - listPullRequestsForBranch hardcodes base 'main' as adapter policy
//   - getClosingPrsForIssue fabricates a placeholder when PR details fail
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-pulls.test.mts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { OctokitPulls } from "../../github/octokit-pulls.ts";
import { parseDepsTimeline } from "../../github/parsers.ts";
import type { GhTimelineNode } from "../../config/types.ts";
import { fakeTransport, createMockLogger } from "./fake-transport.mts";

function adapter(
	octokit: Record<string, unknown>,
	query: (q: string) => Promise<unknown> = async () => ({}),
): OctokitPulls {
	return new OctokitPulls(fakeTransport({ octokit, query }), createMockLogger());
}

// ═══════════════════════════════════════════════════════════════════
// compareBranches
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls.compareBranches", () => {
	it("returns ahead_by and forwards base/head/parsed repo", async () => {
		const compareCommits = mock.fn(async (_params: Record<string, unknown>) => ({
			data: { ahead_by: 3 },
		}));

		const ahead = await adapter({ repos: { compareCommits } }).compareBranches(
			"main",
			"feature",
			"owner/repo",
		);

		assert.equal(ahead, 3);
		const params = compareCommits.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(params.owner, "owner");
		assert.equal(params.repo, "repo");
		assert.equal(params.base, "main");
		assert.equal(params.head, "feature");
	});

	it("invalid repo format throws before any request", async () => {
		const compareCommits = mock.fn(async () => ({ data: { ahead_by: 0 } }));
		await assert.rejects(
			() => adapter({ repos: { compareCommits } }).compareBranches("main", "b", "nope"),
			(err: Error) => err.message === "Invalid repo format: nope (expected owner/name)",
		);
		assert.equal(compareCommits.mock.callCount(), 0);
	});
});

// ═══════════════════════════════════════════════════════════════════
// listPullRequestsForBranch — REST → domain mapping (issue #1472)
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls.listPullRequestsForBranch", () => {
	it("maps a REST-shaped response to domain PrConflictInfo", async () => {
		const list = mock.fn(async (_params: Record<string, unknown>) => ({
			data: [
				{
					number: 123,
					mergeable: false,
					mergeable_state: "dirty",
					head: { ref: "worktree-git-issue-42-foo" },
					base: { ref: "main" },
				},
			],
		}));

		const info = await adapter({ pulls: { list } }).listPullRequestsForBranch(
			"worktree-git-issue-42-foo",
			"owner/repo",
		);

		assert.ok(info, "should find the PR");
		assert.deepEqual(info, {
			number: 123,
			hasConflict: true,
			mergeable: "NOT_MERGEABLE",
			mergeStateStatus: "DIRTY",
			headRefName: "worktree-git-issue-42-foo",
			baseRefName: "main",
		});
	});

	it("queries with head=owner:branch, state=open, per_page=1", async () => {
		const list = mock.fn(async (_params: Record<string, unknown>) => ({ data: [] }));
		await adapter({ pulls: { list } }).listPullRequestsForBranch(
			"worktree-git-issue-42",
			"owner/repo",
		);

		const params = list.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(params.head, "owner:worktree-git-issue-42");
		assert.equal(params.state, "open");
		assert.equal(params.per_page, 1);
	});

	it("returns null for an empty result", async () => {
		const list = mock.fn(async () => ({ data: [] }));
		assert.equal(
			await adapter({ pulls: { list } }).listPullRequestsForBranch("branch", "owner/repo"),
			null,
		);
	});

	it("characterization: still passes base 'main' to the mapper (hidden adapter policy)", async () => {
		// Only `head` is returned, so the base ref can only come from the
		// hardcoded fallback. Fixing this is a separate issue.
		const list = mock.fn(async () => ({
			data: [{ number: 5, mergeable: true, mergeable_state: "clean", head: { ref: "b" } }],
		}));
		const info = await adapter({ pulls: { list } }).listPullRequestsForBranch("b", "owner/repo");
		assert.equal(info?.baseRefName, "main", "base 'main' stays hardcoded for now");
	});

	it("invalid repo format throws", async () => {
		await assert.rejects(
			() => adapter({}).listPullRequestsForBranch("branch", "invalid-repo"),
			/Invalid repo format/,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// createPullRequest / updatePullRequest
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls.createPullRequest / updatePullRequest", () => {
	it("createPullRequest returns the created number", async () => {
		const create = mock.fn(async (_params: Record<string, unknown>) => ({ data: { number: 9 } }));
		const created = await adapter({ pulls: { create } }).createPullRequest({
			repo: "owner/repo",
			base: "main",
			head: "feature",
			title: "t",
			body: "b",
		});

		assert.deepEqual(created, { number: 9 });
		const params = create.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(params.owner, "owner");
		assert.equal(params.repo, "repo");
		assert.equal(params.base, "main");
		assert.equal(params.head, "feature");
		assert.equal(params.title, "t");
		assert.equal(params.body, "b");
	});

	it("updatePullRequest sends body and an optional title", async () => {
		const update = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = adapter({ pulls: { update } });

		await client.updatePullRequest(7, "owner/repo", "new body");
		await client.updatePullRequest(7, "owner/repo", "new body", "new title");

		const first = update.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		const second = update.mock.calls[1]!.arguments[0] as Record<string, unknown>;
		assert.equal(first.pull_number, 7);
		assert.equal(first.body, "new body");
		assert.equal(first.title, undefined);
		assert.equal(second.title, "new title");
	});
});

// ═══════════════════════════════════════════════════════════════════
// checkBlockedByDependencies
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls.checkBlockedByDependencies", () => {
	it("throws on a GraphQL errors payload with messages joined by '; '", async () => {
		const client = adapter({}, async () => ({
			errors: [{ message: "first" }, { message: "second" }],
		}));
		await assert.rejects(
			() => client.checkBlockedByDependencies(1, "owner/repo"),
			(err: Error) => err.message === "GitHub GraphQL error: first; second",
		);
	});

	it("delegates timeline nodes to parseDepsTimeline", async () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 5, title: "Blocker", state: "OPEN" },
			},
		];
		const client = adapter({}, async () => ({
			repository: { issue: { timelineItems: { nodes } } },
		}));

		assert.deepEqual(await client.checkBlockedByDependencies(1, "owner/repo"), {
			blocked: true,
			blockers: [{ number: 5, title: "Blocker", type: "issue", state: "OPEN" }],
		});
	});

	it("missing timeline nodes match parseDepsTimeline(undefined)", async () => {
		const client = adapter({}, async () => ({}));
		assert.deepEqual(
			await client.checkBlockedByDependencies(1, "owner/repo"),
			parseDepsTimeline(undefined),
		);
	});

	it("forwards the parsed repo into the query", async () => {
		const query = mock.fn(async (_q: string) => ({}));
		await adapter({}, query).checkBlockedByDependencies(3, "owner/repo");
		const sent = query.mock.calls[0]!.arguments[0] as string;
		assert.ok(sent.includes('owner: "owner", name: "repo"'));
		assert.ok(sent.includes("issue(number: 3)"));
	});
});

// ═══════════════════════════════════════════════════════════════════
// getClosingPrsForIssue — search policy + classification
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls.getClosingPrsForIssue", () => {
	it("searches all PRs referencing the issue, without an is:open filter", async () => {
		const search = mock.fn(async (_params: Record<string, unknown>) => ({ data: { items: [] } }));
		await adapter({
			search: { issuesAndPullRequests: search },
			pulls: { get: mock.fn() },
		}).getClosingPrsForIssue(42, "owner/repo");

		const params = search.mock.calls[0]!.arguments[0] as { q: string };
		assert.ok(params.q.includes("type:pr"), "query must be limited to PRs");
		assert.ok(params.q.includes("#42"), "query must reference the issue");
		assert.ok(params.q.includes("repo:owner/repo"), "query must be repo-scoped");
		assert.ok(!params.q.includes("is:open"), "merged/closed PRs must not be filtered out");
	});

	it("classifies a closing-keyword PR", async () => {
		const client = adapter({
			search: {
				issuesAndPullRequests: mock.fn(async () => ({ data: { items: [{ number: 1341 }] } })),
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
		});

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");
		assert.deepEqual(refs, [
			{
				number: 1341,
				sha: "8078920",
				source: "closing-keyword",
				branch: "main",
				state: "merged",
			},
		]);
	});

	it("classifies a branch-head PR when the body has no closing keywords", async () => {
		const client = adapter({
			search: {
				issuesAndPullRequests: mock.fn(async () => ({ data: { items: [{ number: 1342 }] } })),
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
		});

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");
		assert.equal(refs.length, 1);
		assert.equal(refs[0]!.source, "branch-head");
		assert.equal(refs[0]!.state, "open");
		assert.equal(refs[0]!.branch, "fix-1289-branch");
	});

	it("fail-open: a search failure resolves [] and warns exactly once", async () => {
		const warn = mock.fn((_scope: string, _message: string) => {});
		const logger = { ...createMockLogger(), warn };
		const client = new OctokitPulls(
			fakeTransport({
				octokit: {
					search: {
						issuesAndPullRequests: mock.fn(async () => {
							throw new Error("API rate limit exceeded");
						}),
					},
				},
			}),
			logger,
		);

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.deepEqual(refs, []);
		assert.equal(warn.mock.callCount(), 1);
		const message = warn.mock.calls[0]!.arguments[1] as string;
		assert.ok(
			message.includes("getClosingPrsForIssue failed"),
			`warning must name the failing operation, got: ${message}`,
		);
	});

	it("characterization: a PR-detail failure keeps the silent placeholder record", async () => {
		const client = adapter({
			search: {
				issuesAndPullRequests: mock.fn(async () => ({ data: { items: [{ number: 42 }] } })),
			},
			pulls: {
				get: mock.fn(async () => {
					throw new Error("Not Found");
				}),
			},
		});

		assert.deepEqual(await client.getClosingPrsForIssue(42, "owner/repo"), [
			{ number: 42, sha: "", source: "branch-head", branch: "", state: "open" },
		]);
	});

	it("invalid repo format throws", async () => {
		await assert.rejects(
			() => adapter({}).getClosingPrsForIssue(1, "invalid-repo"),
			/Invalid repo format/,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Structural pins
// ═══════════════════════════════════════════════════════════════════

describe("OctokitPulls — own-method ceiling (CodeFlow ≤ 15)", () => {
	it("stays at or under 15 own prototype members and is non-vacuous", () => {
		const own = Object.getOwnPropertyNames(OctokitPulls.prototype).length - 1;
		assert.ok(own >= 1, "prototype must declare methods");
		assert.ok(own <= 15, `OctokitPulls has ${own} own methods (ceiling 15)`);
	});
});
