// ─── Tests: pr-creation create-or-update extraction (issue #1827) ─
// upsertPullRequest (idempotent create/update), buildPrBody (single owner
// of the summary argument mapping), and the pins createPrOnApproval keeps.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import { buildPrBody, createPrOnApproval, upsertPullRequest } from "../../pipeline/pr-creation.ts";
import { buildPipelineSummary } from "../../pipeline/output.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

const agentResults: PipelineAgentResult[] = [
	{
		agentName: "developer",
		status: "SUCCESS",
		durationMs: 1200,
		tokenCount: 900,
		toolCount: 12,
		model: "anthropic/claude-sonnet",
	},
];

function makeConflictInfo(prNumber: number): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

interface NotifyCall {
	message: string;
	level: string;
}

function makeNotify(): { calls: NotifyCall[]; notify: (m: string, l: string) => void } {
	const calls: NotifyCall[] = [];
	return {
		calls,
		notify: (message: string, level: string) => {
			calls.push({ message, level });
		},
	};
}

const baseInput = {
	repo: "owner/repo",
	base: "main",
	head: "worktree-git-issue-42-test",
	title: "feat(#42): Test issue",
	body: "## body",
};

const flushQueue = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─── buildPrBody + in-progress status ────────────────────────────

describe("buildPrBody()", () => {
	it("builds feat(#N) title and an in-progress body with issue + agent row", () => {
		const { title, body } = buildPrBody(42, "Test issue", agentResults, mockConfig);
		assert.equal(title, "feat(#42): Test issue");
		assert.ok(
			body.startsWith("## 🚧 Pipeline In Progress — Issue #42"),
			`header must announce in-progress, got: ${body.split("\n")[0]}`,
		);
		assert.ok(body.includes("Closes #42"));
		assert.ok(body.includes("| developer |"), "developer row rendered from agentResults");
		assert.ok(!body.includes("Pipeline Complete"), "must not claim completion before audit");
	});
});

describe("buildPipelineSummary() — in-progress status", () => {
	it("renders the in-progress header and never claims completion", () => {
		const out = buildPipelineSummary(agentResults, "in-progress", 42, "T", mockConfig);
		assert.ok(out.startsWith("## 🚧 Pipeline In Progress — Issue #42"));
		assert.ok(!out.includes("Pipeline Complete"));
	});

	it("keeps existing status mappings unchanged", () => {
		const success = buildPipelineSummary([], "success", 42, "T", mockConfig);
		assert.ok(success.includes("## ✅ Pipeline Complete — Issue #42"));

		const failed = buildPipelineSummary([], "failed", 42, "T", mockConfig);
		assert.ok(failed.includes("## ❌ Pipeline Failed — Issue #42"));

		const stopped = buildPipelineSummary([], "stopped", 42, "T", mockConfig);
		assert.ok(stopped.includes("## ⏹ Pipeline Stopped — Issue #42"));

		const prFailed = buildPipelineSummary([], "success", 42, "T", mockConfig, undefined, {
			success: false,
			error: "boom",
			source: "pr-creation",
		});
		assert.ok(prFailed.includes("## ⚠️ Pipeline Complete (PR creation failed) — Issue #42"));
	});
});

// ─── upsertPullRequest() ─────────────────────────────────────────

describe("upsertPullRequest()", () => {
	it("no open PR → createPullRequest called once with base/head/title/body", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			calls,
		);

		const result = await upsertPullRequest({ ...baseInput, port });

		assert.deepEqual(result, {
			success: true,
			prNumber: 456,
			source: "pr-creation",
		});
		const creates = calls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		assert.deepEqual(creates[0]!.args[0], {
			repo: "owner/repo",
			base: "main",
			head: "worktree-git-issue-42-test",
			title: "feat(#42): Test issue",
			body: "## body",
		});
	});

	it("open PR #789 → updatePullRequest once, zero createPullRequest", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => makeConflictInfo(789),
				updatePullRequest: async () => {},
			},
			calls,
		);

		const result = await upsertPullRequest({ ...baseInput, port });

		assert.deepEqual(result, {
			success: true,
			prNumber: 789,
			wasUpdate: true,
			source: "pr-creation",
		});
		const updates = calls.filter((c) => c.method === "updatePullRequest");
		assert.equal(updates.length, 1);
		assert.deepEqual(updates[0]!.args, [789, "owner/repo", "## body", "feat(#42): Test issue"]);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
	});

	it("idempotent: second call for the same branch updates instead of creating a duplicate", async () => {
		const calls: PortCall[] = [];
		let listed: PrConflictInfo | null = null;
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => listed,
				createPullRequest: async () => {
					listed = makeConflictInfo(789);
					return { number: 789 };
				},
				updatePullRequest: async () => {},
			},
			calls,
		);

		const first = await upsertPullRequest({ ...baseInput, port });
		const second = await upsertPullRequest({ ...baseInput, port });

		assert.equal(first.success, true);
		assert.equal(first.wasUpdate, undefined);
		assert.equal(second.success, true);
		assert.equal(second.wasUpdate, true);
		assert.equal(second.prNumber, 789);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 1);
		assert.equal(calls.filter((c) => c.method === "updatePullRequest").length, 1);
	});

	it("listPullRequestsForBranch rejects → warning notify, create still attempted", async () => {
		const { calls: notifyCalls, notify } = makeNotify();
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => {
				throw new Error("network error");
			},
			createPullRequest: async () => ({ number: 456 }),
		});

		const result = await upsertPullRequest({ ...baseInput, port, notify });

		assert.equal(result.success, true);
		const warning = notifyCalls.find(
			(n) => n.level === "warning" && n.message.includes("PR conflict check failed"),
		);
		assert.ok(warning, "warning notify surfaced for the failed PR lookup");
	});

	it("updatePullRequest rejects → failure, createPullRequest not called", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => makeConflictInfo(789),
				updatePullRequest: async () => {
					throw new Error("boom");
				},
			},
			calls,
		);

		const result = await upsertPullRequest({ ...baseInput, port });

		assert.equal(result.success, false);
		assert.equal(result.source, "pr-creation");
		assert.ok(result.error?.includes("Failed to update PR"), result.error);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
	});

	it("createPullRequest rejects on every retry → failure with the last error", async () => {
		let attempts = 0;
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				attempts++;
				throw new Error(`transient ${attempts}`);
			},
		});

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof upsertPullRequest>>;
		try {
			const promise = upsertPullRequest({ ...baseInput, port });
			await flushQueue();
			mock.timers.tick(1000);
			await flushQueue();
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(attempts, 2, "create retried once");
		assert.equal(result.success, false);
		assert.equal(result.error, "transient 2");
	});

	it("422 already exists → re-list and update that PR (no duplicate, no retry loop)", async () => {
		const calls: PortCall[] = [];
		let listCount = 0;
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => {
					listCount++;
					return listCount === 1 ? null : makeConflictInfo(789);
				},
				createPullRequest: async () => {
					throw new Error("GraphQL: 422 Validation Failed — A pull request already exists");
				},
				updatePullRequest: async () => {},
			},
			calls,
		);

		const result = await upsertPullRequest({ ...baseInput, port });

		assert.equal(result.success, true);
		assert.equal(result.wasUpdate, true);
		assert.equal(result.prNumber, 789);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 1);
		assert.equal(calls.filter((c) => c.method === "updatePullRequest").length, 1);
	});

	it("422 already exists but re-list finds nothing → fails fast with the 422 message", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => {
					throw new Error("422 pull request already exists");
				},
			},
			calls,
		);

		const result = await upsertPullRequest({ ...baseInput, port });

		assert.equal(result.success, false);
		assert.ok(result.error?.includes("422"), result.error);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 1);
	});

	it("no port → no PR calls and an error mentioning port unavailable", async () => {
		const result = await upsertPullRequest({ ...baseInput, port: undefined });

		assert.equal(result.success, false);
		assert.equal(result.source, "pr-creation");
		assert.match(result.error ?? "", /port/i);
	});
});

// ─── createPrOnApproval keeps its ahead-check / rebase / push pins ─

function makeResolvingPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls: Array<{ cmd: string; args: string[] }> = [],
): ExtensionAPI {
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], _opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args ?? [] });
			return Promise.resolve(results[idx++] ?? { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

function makeCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_s: string, t: string) => t } },
	} as unknown as ExtensionCommandContext;
}

describe("createPrOnApproval() — pins preserved by the extraction", () => {
	it("compareBranches → 0: pushSkipped, no PR created", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ compareBranches: async () => 0 }, calls);

		const result = await createPrOnApproval(
			makeResolvingPi([]),
			makeCtx(),
			42,
			"Test issue",
			mockConfig,
			agentResults,
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(result.pushSkipped, true);
		assert.equal(result.success, false);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
	});

	it("rebase conflict: rebaseConflicts populated, no PR created", async () => {
		const execCalls: Array<{ cmd: string; args: string[] }> = [];
		const pi = makeResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rebase conflict" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge conflict" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ compareBranches: async () => 3 }, calls);

		const result = await createPrOnApproval(
			pi,
			makeCtx(),
			42,
			"Test issue",
			mockConfig,
			agentResults,
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(result.success, false);
		assert.deepEqual(result.rebaseConflicts, ["src/a.ts"]);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
		assert.equal(execCalls.filter((c) => c.args[0] === "push").length, 0);
	});
});
