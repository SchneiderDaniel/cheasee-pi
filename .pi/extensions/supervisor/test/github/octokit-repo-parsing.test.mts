// ─── Tests: repo parsing across the split adapters (issue #2098) ───
// Originally pinned the adapter-private `parseRepo` of the single
// OctokitClient (issue #2102). After the port split the guard lives once in
// RepoAdapterBase, so the contract is pinned here for BOTH repo-taking
// adapters — and asserted to have exactly one textual definition.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-repo-parsing.test.mts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OctokitIssues } from "../../github/octokit-issues.ts";
import { OctokitPulls } from "../../github/octokit-pulls.ts";
import type { GitHubTransport } from "../../github/github-transport.ts";
import { fakeTransport, createMockLogger } from "./fake-transport.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_DIR = join(__dirname, "../../github");

const INVALID_REPO = "nope";
const INVALID_MESSAGE = "Invalid repo format: nope (expected owner/name)";

interface Recorded {
	api: string;
	args: Record<string, unknown>;
}

/** Octokit/graphql stub that records every call and never touches the network. */
function recordingTransport(log: Recorded[]): GitHubTransport {
	const rec = (api: string, response: unknown) =>
		mock.fn(async (args: Record<string, unknown>) => {
			log.push({ api, args });
			return response;
		});
	return fakeTransport({
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
		query: async (query: string) => {
			log.push({ api: "graphql", args: { query } });
			return { repository: { issue: { timelineItems: { nodes: [] } } } };
		},
	}) as GitHubTransport;
}

/** Transport stand-in that fails loudly if any HTTP path is reached. */
function throwingTransport(): GitHubTransport {
	const thrower = new Proxy(
		{},
		{
			get() {
				throw new Error("HTTP call attempted despite invalid repo");
			},
		},
	);
	return fakeTransport({
		octokit: thrower as unknown as Record<string, unknown>,
		query: async () => {
			throw new Error("HTTP call attempted despite invalid repo");
		},
	});
}

type AnyAdapter = OctokitIssues | OctokitPulls;

interface MethodCase {
	name: string;
	build: (transport: GitHubTransport) => AnyAdapter;
	invoke: (adapter: AnyAdapter, repo: string) => Promise<unknown>;
}

function issues(transport: GitHubTransport): OctokitIssues {
	return new OctokitIssues(transport, createMockLogger());
}

function pulls(transport: GitHubTransport): OctokitPulls {
	return new OctokitPulls(transport, createMockLogger());
}

/** Every repo-taking method across the split adapters (ten in total). */
const REPO_METHODS: MethodCase[] = [
	{
		name: "OctokitIssues.getIssue",
		build: issues,
		invoke: (a, repo) => (a as OctokitIssues).getIssue(1, repo),
	},
	{
		name: "OctokitIssues.getIssueWithComments",
		build: issues,
		invoke: (a, repo) => (a as OctokitIssues).getIssueWithComments(1, repo),
	},
	{
		name: "OctokitIssues.closeIssue",
		build: issues,
		invoke: (a, repo) => (a as OctokitIssues).closeIssue(1, repo),
	},
	{
		name: "OctokitIssues.postIssueComment",
		build: issues,
		invoke: (a, repo) => (a as OctokitIssues).postIssueComment(1, repo, "body"),
	},
	{
		name: "OctokitPulls.compareBranches",
		build: pulls,
		invoke: (a, repo) => (a as OctokitPulls).compareBranches("main", "b", repo),
	},
	{
		name: "OctokitPulls.listPullRequestsForBranch",
		build: pulls,
		invoke: (a, repo) => (a as OctokitPulls).listPullRequestsForBranch("b", repo),
	},
	{
		name: "OctokitPulls.createPullRequest",
		build: pulls,
		invoke: (a, repo) =>
			(a as OctokitPulls).createPullRequest({ repo, base: "main", head: "b", title: "t" }),
	},
	{
		name: "OctokitPulls.updatePullRequest",
		build: pulls,
		invoke: (a, repo) => (a as OctokitPulls).updatePullRequest(1, repo, "body"),
	},
	{
		name: "OctokitPulls.checkBlockedByDependencies",
		build: pulls,
		invoke: (a, repo) => (a as OctokitPulls).checkBlockedByDependencies(1, repo),
	},
	{
		name: "OctokitPulls.getClosingPrsForIssue",
		build: pulls,
		invoke: (a, repo) => (a as OctokitPulls).getClosingPrsForIssue(1, repo),
	},
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

// ═══════════════════════════════════════════════════════════════════
// One shared guard, identical message
// ═══════════════════════════════════════════════════════════════════

describe("repo parsing — shared guard across split adapters", () => {
	for (const { name, build, invoke } of REPO_METHODS) {
		it(`${name} rejects a repo without owner/name before any HTTP call`, async () => {
			const adapter = build(throwingTransport());
			await assert.rejects(
				() => invoke(adapter, INVALID_REPO),
				(err: Error) => {
					assert.equal(err.message, INVALID_MESSAGE);
					return true;
				},
			);
		});
	}

	for (const repo of ["", "/repo", "owner/", "/"]) {
		it(`rejects ${JSON.stringify(repo)} with the exact message and no HTTP call`, async () => {
			for (const { name, build, invoke } of REPO_METHODS) {
				const adapter = build(throwingTransport());
				await assert.rejects(
					() => invoke(adapter, repo),
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

	for (const { name, build, invoke } of REPO_METHODS) {
		it(`${name} splits owner/repo and forwards both as defined strings`, async () => {
			const log: Recorded[] = [];
			await invoke(build(recordingTransport(log)), "owner/repo");
			assertRepoForwarded(log, "owner", "repo");
		});

		it(`${name} ignores an extra path segment (owner=a, repo=b)`, async () => {
			const log: Recorded[] = [];
			await invoke(build(recordingTransport(log)), "a/b/c");
			assertRepoForwarded(log, "a", "b");
		});
	}

	it("createPullRequest validates input.repo, not the input object", async () => {
		const adapter = pulls(throwingTransport());
		await assert.rejects(
			() => adapter.createPullRequest({ repo: INVALID_REPO, base: "main", head: "b", title: "t" }),
			(err: Error) => {
				assert.equal(err.message, INVALID_MESSAGE);
				assert.ok(!err.message.includes("[object Object]"));
				return true;
			},
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// The guard lives in exactly one place
// ═══════════════════════════════════════════════════════════════════

function githubSources(): string[] {
	return readdirSync(GITHUB_DIR)
		.filter((name) => name.endsWith(".ts") && !name.includes(".test."))
		.map((name) => join(GITHUB_DIR, name));
}

describe("parseRepo — one shared helper, zero duplicated literal", () => {
	it("declares the invalid-repo message exactly once", () => {
		const bearers = githubSources()
			.filter((file) => readFileSync(file, "utf-8").includes("Invalid repo format:"))
			.map((file) => basename(file));
		assert.deepEqual(bearers, ["adapter-base.ts"]);
	});

	it("is not part of any adapter's export surface", async () => {
		for (const module of [
			"octokit-issues.ts",
			"octokit-pulls.ts",
			"octokit-projects.ts",
			"adapter-base.ts",
		]) {
			const mod = (await import(`../../github/${module}`)) as Record<string, unknown>;
			assert.equal("parseRepo" in mod, false, `${module} must not export parseRepo`);
		}
	});
});
