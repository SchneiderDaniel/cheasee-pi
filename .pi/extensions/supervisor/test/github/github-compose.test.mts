// ─── Tests: github/compose.ts — composition root (issue #2098) ───
// Phase 5 — nothing may be lost in delegation. The 22-member list is
// hardcoded: a missing delegation fails here, which is the primary risk of
// the God-Object split.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/github-compose.test.mts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort } from "../../github/ports.ts";
import type { GitHubTransport } from "../../github/github-transport.ts";
import { composeGitHubPort, createGitHubPort } from "../../github/compose.ts";

// ─── Token-aware recording transport ─────────────────────────────

interface Recorded {
	api: string;
	auth: string;
	args: Record<string, unknown>;
}

/**
 * Transport fake whose `setToken` swaps BOTH handles in place, exactly like
 * the real one. Every REST call records the authorization token it observed.
 */
function recordingTransport(): { transport: GitHubTransport; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let token = "t1";

	const octokitFor = (auth: string): Record<string, unknown> => {
		const rec =
			(api: string, response: unknown) =>
			async (args: Record<string, unknown> = {}) => {
				calls.push({ api, auth, args });
				return response;
			};
		return {
			issues: {
				get: rec("issues.get", { data: { number: 1, title: "t", body: "b" } }),
				update: rec("issues.update", { data: {} }),
				createComment: rec("issues.createComment", { data: {} }),
				updateComment: rec("issues.updateComment", { data: {} }),
				listComments: rec("issues.listComments", { data: [] }),
				listLabelsOnIssue: rec("issues.listLabelsOnIssue", { data: [{ name: "bug" }] }),
			},
			repos: { compareCommits: rec("repos.compareCommits", { data: { ahead_by: 2 } }) },
			users: { getAuthenticated: rec("users.getAuthenticated", { data: { login: "bot" } }) },
			pulls: {
				list: rec("pulls.list", { data: [] }),
				create: rec("pulls.create", { data: { number: 11 } }),
				update: rec("pulls.update", { data: {} }),
				get: rec("pulls.get", { data: { number: 11 } }),
			},
			search: {
				issuesAndPullRequests: rec("search.issuesAndPullRequests", { data: { items: [] } }),
			},
		};
	};

	const transport: {
		octokit: Record<string, unknown>;
		graphql: unknown;
		query: (query: string) => Promise<unknown>;
		setToken: (next: string) => void;
	} = {
		octokit: octokitFor(token),
		graphql: {},
		query: async (query: string) => {
			calls.push({ api: "query", auth: token, args: { query } });
			return { viewer: { projectV2: { fields: { nodes: [] }, id: "PVT_1" } } };
		},
		setToken: (next: string) => {
			token = next;
			transport.octokit = octokitFor(next);
		},
	};

	return { transport: transport as unknown as GitHubTransport, calls };
}

// ─── The full GitHubPort surface, hardcoded (22 members) ──────────

const PORT_MEMBERS = [
	"getIssue",
	"getIssueWithComments",
	"listComments",
	"getAuthenticatedLogin",
	"closeIssue",
	"postIssueComment",
	"updateIssueComment",
	"getIssueLabels",
	"addIssueLabel",
	"removeIssueLabel",
	"deleteIssueComment",
	"compareBranches",
	"listPullRequestsForBranch",
	"createPullRequest",
	"updatePullRequest",
	"getProjectFields",
	"getProjectItems",
	"getProjectId",
	"setItemStatusField",
	"checkBlockedByDependencies",
	"getClosingPrsForIssue",
	"setToken",
] as const;

// ═══════════════════════════════════════════════════════════════════
// Surface conformance
// ═══════════════════════════════════════════════════════════════════

describe("composeGitHubPort() — surface conformance", () => {
	it("exposes all 22 GitHubPort members as functions", () => {
		const { transport } = recordingTransport();
		const port = composeGitHubPort(transport);

		for (const member of PORT_MEMBERS) {
			assert.equal(
				typeof (port as unknown as Record<string, unknown>)[member],
				"function",
				`port.${member} must be delegated`,
			);
		}
		assert.equal(PORT_MEMBERS.length, 22, "the hardcoded surface list must stay at 22 members");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Delegation routing — every family reaches its adapter
// ═══════════════════════════════════════════════════════════════════

describe("composeGitHubPort() — delegation routing", () => {
	it("routes issue calls to transport.octokit.issues", async () => {
		const { transport, calls } = recordingTransport();
		const port = composeGitHubPort(transport);

		await port.getIssue(1, "owner/repo");
		assert.deepEqual(
			calls.map((c) => c.api),
			["issues.get"],
		);
	});

	it("routes pull calls to transport.octokit.repos", async () => {
		const { transport, calls } = recordingTransport();
		const port = composeGitHubPort(transport);

		assert.equal(await port.compareBranches("main", "f", "owner/repo"), 2);
		assert.deepEqual(
			calls.map((c) => c.api),
			["repos.compareCommits"],
		);
	});

	it("routes project calls to transport.query", async () => {
		const { transport, calls } = recordingTransport();
		const port = composeGitHubPort(transport);

		assert.deepEqual(await port.getProjectFields(3), []);
		assert.deepEqual(
			calls.map((c) => c.api),
			["query"],
		);
	});

	it("exposes the base-class issue ops (labels) through the composed port", async () => {
		const { transport, calls } = recordingTransport();
		const port = composeGitHubPort(transport);

		assert.deepEqual(await port.getIssueLabels(1, "owner/repo"), ["bug"]);
		assert.deepEqual(
			calls.map((c) => c.api),
			["issues.listLabelsOnIssue"],
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// One transport shared by all three sub-adapters
// ═══════════════════════════════════════════════════════════════════

describe("composeGitHubPort() — shared transport", () => {
	it("setToken reaches every sub-adapter (no per-adapter token copy)", async () => {
		const { transport, calls } = recordingTransport();
		const port = composeGitHubPort(transport);

		port.setToken("t2");

		await port.getIssue(1, "owner/repo");
		await port.compareBranches("main", "f", "owner/repo");
		await port.getProjectFields(3);

		assert.deepEqual(
			calls.map((c) => c.api),
			["issues.get", "repos.compareCommits", "query"],
		);
		for (const call of calls) {
			assert.equal(call.auth, "t2", `${call.api} must carry the swapped token`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// createGitHubPort — token resolution + fail-closed throw
// ═══════════════════════════════════════════════════════════════════

async function withEnv(
	home: string,
	ghToken: string | undefined,
	fn: () => Promise<void>,
): Promise<void> {
	const savedHome = process.env.HOME;
	const savedToken = process.env.GH_TOKEN;
	process.env.HOME = home;
	if (ghToken === undefined) delete process.env.GH_TOKEN;
	else process.env.GH_TOKEN = ghToken;
	try {
		await fn();
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedToken === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = savedToken;
	}
}

describe("createGitHubPort()", () => {
	it("injected literal token → returns a full port without touching the filesystem", async () => {
		const home = mkdtempSync(join(tmpdir(), "gh-compose-literal-"));
		try {
			await withEnv(home, undefined, async () => {
				const port: GitHubPort = createGitHubPort("gho_literal");
				for (const member of PORT_MEMBERS) {
					assert.equal(
						typeof (port as unknown as Record<string, unknown>)[member],
						"function",
						`port.${member} must be a function`,
					);
				}
				assert.doesNotThrow(() => port.setToken("gho_next"));
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws 'GitHub token not found' when no token resolves (fail-closed)", async () => {
		const home = mkdtempSync(join(tmpdir(), "gh-compose-throw-"));
		try {
			await withEnv(home, undefined, async () => {
				assert.throws(() => createGitHubPort(), /GitHub token not found/);
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
