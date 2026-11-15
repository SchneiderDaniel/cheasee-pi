// ─── Tests: OctokitClient — repo parsing + closing-PR delegation ───
// Split out of octokit-client.test.mts (issue #2102): the repo-string
// contract and the getClosingPrsForIssue delegation checks live here so the
// original suite stays well under the Rule 1 file-size ceiling.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-repo-parsing.test.mts

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
// Repo parsing — adapter-private `parseRepo` (issue #2102)
// Ten public methods used to repeat the same split/guard block. They now
// share one private helper; these tests pin its observable contract.
// ═══════════════════════════════════════════════════════════════════════

const INVALID_REPO = "nope";
const INVALID_MESSAGE = "Invalid repo format: nope (expected owner/name)";

interface Recorded {
	api: string;
	args: Record<string, unknown>;
}

/** Octokit/graphql stub that records every call and never touches the network. */
function recordingStub(log: Recorded[]): {
	octokit: Record<string, unknown>;
	graphql: (query: string) => Promise<unknown>;
} {
	const rec = (api: string, response: unknown) =>
		mock.fn(async (args: Record<string, unknown>) => {
			log.push({ api, args });
			return response;
		});
	return {
		octokit: {
			issues: {
				get: rec("issues.get", {
					data: { number: 7, title: "t", body: "b", user: { login: "u" } },
				}),
				update: rec("issues.update", { data: {} }),
				createComment: rec("issues.createComment", { data: {} }),
				listComments: rec("issues.listComments", { data: [] }),
			},
			repos: { compareCommits: rec("repos.compareCommits", { data: { ahead_by: 0 } }) },
			pulls: {
				list: rec("pulls.list", { data: [] }),
				create: rec("pulls.create", { data: { number: 9 } }),
				update: rec("pulls.update", { data: {} }),
				get: rec("pulls.get", { data: { number: 5 } }),
			},
			search: {
				issuesAndPullRequests: rec("search.issuesAndPullRequests", {
					data: { items: [{ number: 5 }] },
				}),
			},
		},
		graphql: async (query: string) => {
			log.push({ api: "graphql", args: { query } });
			return { repository: { issue: { timelineItems: { nodes: [] } } } };
		},
	};
}

/** Octokit/graphql stand-in that fails loudly if any HTTP path is reached. */
function throwingStub(): Record<string, unknown> {
	return new Proxy({} as Record<string, unknown>, {
		get() {
			throw new Error("HTTP call attempted despite invalid repo");
		},
	});
}

/** The ten repo-taking public methods, invoked with a caller-supplied repo string. */
const REPO_METHODS: Array<{
	name: string;
	invoke: (client: OctokitClient, repo: string) => Promise<unknown>;
}> = [
	{ name: "getIssue", invoke: (c, repo) => c.getIssue(1, repo) },
	{ name: "getIssueWithComments", invoke: (c, repo) => c.getIssueWithComments(1, repo) },
	{ name: "closeIssue", invoke: (c, repo) => c.closeIssue(1, repo) },
	{ name: "postIssueComment", invoke: (c, repo) => c.postIssueComment(1, repo, "body") },
	{ name: "compareBranches", invoke: (c, repo) => c.compareBranches("main", "b", repo) },
	{
		name: "listPullRequestsForBranch",
		invoke: (c, repo) => c.listPullRequestsForBranch("b", repo),
	},
	{
		name: "createPullRequest",
		invoke: (c, repo) => c.createPullRequest({ repo, base: "main", head: "b", title: "t" }),
	},
	{ name: "updatePullRequest", invoke: (c, repo) => c.updatePullRequest(1, repo, "body") },
	{
		name: "checkBlockedByDependencies",
		invoke: (c, repo) => c.checkBlockedByDependencies(1, repo),
	},
	{ name: "getClosingPrsForIssue", invoke: (c, repo) => c.getClosingPrsForIssue(1, repo) },
];

/** Assert every recorded call carries the parsed owner/name pair. */
function assertRepoForwarded(log: Recorded[], owner: string, name: string): void {
	assert.ok(log.length > 0, "expected at least one API call");
	for (const call of log) {
		if (call.api === "graphql") {
			assert.ok(
				String(call.args.query).includes(`owner: "${owner}", name: "${name}"`),
				`graphql query must carry owner=${owner} name=${name}`,
			);
			continue;
		}
		if (call.api === "search.issuesAndPullRequests") {
			assert.ok(
				String(call.args.q).includes(`repo:${owner}/${name}`),
				"search query must carry the reparsed repo slug",
			);
			continue;
		}
		assert.equal(call.args.owner, owner, `${call.api} must receive owner=${owner}`);
		assert.equal(call.args.repo, name, `${call.api} must receive repo=${name}`);
	}
}

describe("OctokitClient — repo parsing (parseRepo extraction)", () => {
	for (const { name, invoke } of REPO_METHODS) {
		it(`${name} rejects a repo without owner/name before any HTTP call`, async () => {
			const client = new OctokitClient("fake-token", createMockLogger() as any);
			(client as any).octokit = throwingStub();
			(client as any)._graphql = throwingStub();

			await assert.rejects(
				() => invoke(client, INVALID_REPO),
				(err: Error) => {
					assert.equal(err.message, INVALID_MESSAGE);
					return true;
				},
			);
		});
	}

	for (const repo of ["", "/repo", "owner/", "/"]) {
		it(`rejects ${JSON.stringify(repo)} with the exact message and no HTTP call`, async () => {
			for (const { name, invoke } of REPO_METHODS) {
				const client = new OctokitClient("fake-token", createMockLogger() as any);
				(client as any).octokit = throwingStub();
				(client as any)._graphql = throwingStub();

				await assert.rejects(
					() => invoke(client, repo),
					(err: Error) => {
						assert.equal(
							err.message,
							`Invalid repo format: ${repo} (expected owner/name)`,
							`${name} must reject ${JSON.stringify(repo)} verbatim`,
						);
						return true;
					},
				);
			}
		});
	}

	for (const { name, invoke } of REPO_METHODS) {
		it(`${name} splits owner/repo and forwards both as defined strings`, async () => {
			const log: Recorded[] = [];
			const stub = recordingStub(log);
			const client = new OctokitClient("fake-token", createMockLogger() as any);
			(client as any).octokit = stub.octokit;
			(client as any)._graphql = stub.graphql;

			await invoke(client, "owner/repo");
			assertRepoForwarded(log, "owner", "repo");
		});

		it(`${name} ignores an extra path segment (owner=a, repo=b)`, async () => {
			const log: Recorded[] = [];
			const stub = recordingStub(log);
			const client = new OctokitClient("fake-token", createMockLogger() as any);
			(client as any).octokit = stub.octokit;
			(client as any)._graphql = stub.graphql;

			await invoke(client, "a/b/c");
			assertRepoForwarded(log, "a", "b");
		});
	}

	it("createPullRequest validates input.repo, not the input object", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = throwingStub();

		await assert.rejects(
			() => client.createPullRequest({ repo: INVALID_REPO, base: "main", head: "b", title: "t" }),
			(err: Error) => {
				assert.equal(err.message, INVALID_MESSAGE);
				assert.ok(!err.message.includes("[object Object]"));
				return true;
			},
		);
	});

	it("parseRepo is not part of the module's export surface", async () => {
		const mod = (await import("../../github/octokit-client.ts")) as Record<string, unknown>;
		assert.equal("parseRepo" in mod, false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// getClosingPrsForIssue — adapter delegation to mapPrToClosingRef
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.getClosingPrsForIssue — mapper delegation", () => {
	it("looks up details with the search item's number", async () => {
		const search = mock.fn(async () => ({ data: { items: [{ number: 77 }] } }));
		const get = mock.fn(async (_args: Record<string, unknown>) => ({
			data: {
				number: 77,
				merge_commit_sha: "sha77",
				merged_at: "2025-01-01T00:00:00Z",
				state: "closed",
				head: { ref: "branch-77", sha: "head77" },
				body: "Closes #42",
			},
		}));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { search: { issuesAndPullRequests: search }, pulls: { get } };

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");

		const args = get.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(args.owner, "owner");
		assert.equal(args.repo, "repo");
		assert.equal(args.pull_number, 77);
		assert.deepEqual(refs, [
			{ number: 77, sha: "sha77", source: "closing-keyword", branch: "branch-77", state: "merged" },
		]);
	});

	it("detail lookup failure yields the preserved empty-sha open characterization", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => ({ data: { items: [{ number: 42 }] } })),
			},
			pulls: {
				get: mock.fn(async () => {
					throw new Error("Not Found");
				}),
			},
		};

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");
		assert.deepEqual(refs, [
			{ number: 42, sha: "", source: "branch-head", branch: "", state: "open" },
		]);
	});

	it("outer search failure resolves [] and warns once through the logger", async () => {
		const warn = mock.fn((_scope: string, _message: string) => {});
		const logger = { ...createMockLogger(), warn };
		const client = new OctokitClient("fake-token", logger as any);
		(client as any).octokit = {
			search: {
				issuesAndPullRequests: mock.fn(async () => {
					throw new Error("API rate limit exceeded");
				}),
			},
		};

		const refs = await client.getClosingPrsForIssue(42, "owner/repo");

		assert.deepEqual(refs, []);
		assert.equal(warn.mock.callCount(), 1);
		const message = warn.mock.calls[0]!.arguments[1] as string;
		assert.ok(
			message.includes("getClosingPrsForIssue failed"),
			`warning must name the failing operation, got: ${message}`,
		);
	});
});
