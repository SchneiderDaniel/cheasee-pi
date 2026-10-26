// ─── Tests: developer PR upsert stage (issue #1827) ──────────────
// A PR must exist after the developer's commit is pushed and before any
// pre-audit gate runs. Covers upsertDeveloperPr (skip paths, fail-soft,
// no extra git work) and its wiring through handlePostAgentSuccess.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	AgentRunResult,
	FilteredIssueData,
	PipelineAgentResult,
} from "../../config/types.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";
import { handlePostAgentSuccess, upsertDeveloperPr } from "../../pipeline/stages/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const developerResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 1200,
	tokenCount: 900,
	toolCount: 12,
	model: "anthropic/claude-sonnet",
};

interface ExecCall {
	cmd: string;
	args: string[];
}

/** Exec mock that resolves — an unscripted call yields a clean no-op git run. */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls: ExecCall[] = [],
): ExtensionAPI {
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], _opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args ?? [] });
			return Promise.resolve(results[idx++] ?? { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_s: string, t: string) => t } },
	} as unknown as ExtensionCommandContext;
}

function makeNotify(): { calls: { message: string; level: string }[]; notify: NotifyFn } {
	const calls: { message: string; level: string }[] = [];
	return {
		calls,
		notify: {
			info: (message: string) => calls.push({ message, level: "info" }),
			error: (message: string) => calls.push({ message, level: "error" }),
		},
	};
}

function prCalls(calls: PortCall[]): PortCall[] {
	return calls.filter((c) =>
		["listPullRequestsForBranch", "createPullRequest", "updatePullRequest"].includes(c.method),
	);
}

const baseDeps = {
	issueNum: 42,
	issueTitle: "Test issue",
	config: mockConfig,
	worktreePath: "/repo/worktree",
	worktreeBranch: "worktree-git-issue-42-test",
	agentResults: [developerResult],
};

const baseRunResult: AgentRunResult = {
	output: "",
	success: true,
	agentName: "developer",
	toolCount: 5,
	tokenCount: 2000,
	durationMs: 10000,
	textOutput: "IMPLEMENTATION_COMPLETE",
	summaryLine: "Implemented",
	errorOutput: "",
	textOnly: "IMPLEMENTATION_COMPLETE",
};

const emptyFilteredData: FilteredIssueData = { body: "", comments: [] };

// ─── upsertDeveloperPr() ─────────────────────────────────────────

describe("upsertDeveloperPr()", () => {
	it("no worktreeBranch → not created, no PR calls, no throw", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const result = await upsertDeveloperPr({
			...baseDeps,
			worktreeBranch: undefined,
			pi: createMockPi([]),
			port,
		});

		assert.equal(result.success, false);
		assert.equal(portCalls.length, 0);
	});

	it("no port → skips the git pre-check and any PR call", async () => {
		const execCalls: ExecCall[] = [];

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "3\n", stderr: "" }], execCalls),
			port: undefined,
		});

		assert.equal(result.success, false);
		assert.equal(execCalls.length, 0);
	});

	it("no commits on the branch → skipped, zero PR calls", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "0\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, false);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("commits present → creates the PR for branch/base", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "3\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, true);
		assert.equal(result.prNumber, 456);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		const input = creates[0]!.args[0] as { base: string; head: string; body: string };
		assert.equal(input.base, "main");
		assert.equal(input.head, "worktree-git-issue-42-test");
		assert.ok(input.body.includes("Pipeline In Progress"));
		assert.ok(input.body.includes("Closes #42"));
	});

	it("git rev-list failure (code 128) → fail-safe, upsert still attempted", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const execCalls: ExecCall[] = [];
		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 128, stdout: "", stderr: "fatal" }], execCalls),
			port,
		});

		assert.equal(result.success, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		assert.equal(execCalls.length, 1, "only the rev-list pre-check runs");
	});

	it("early path does no push/fetch/rebase and exactly one rev-list", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => ({ number: 456 }),
		});

		await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }], execCalls),
			port,
		});

		const revLists = execCalls.filter((c) => c.args[0] === "rev-list");
		assert.equal(revLists.length, 1);
		assert.deepEqual(revLists[0]!.args, [
			"rev-list",
			"--count",
			"main..worktree-git-issue-42-test",
		]);
		for (const verb of ["push", "fetch", "rebase"]) {
			assert.equal(
				execCalls.filter((c) => c.args[0] === verb).length,
				0,
				`early upsert must not run git ${verb}`,
			);
		}
	});

	it("createPullRequest rejects → resolves, one error notify, one collector entry", async () => {
		const { calls: notifyCalls, notify } = makeNotify();
		const collector = new ErrorCollector();
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				throw new Error("500 internal");
			},
		});

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
			notify,
			collector,
		});

		assert.equal(result.success, false);
		const errors = notifyCalls.filter((n) => n.level === "error");
		assert.equal(errors.length, 1, "exactly one error notify");
		assert.match(errors[0]!.message, /PR/i);
		assert.equal(collector.flush("developer-pr").length, 1);
	});

	it("collector omitted on the failure path → resolves without throwing", async () => {
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				throw new Error("500 internal");
			},
		});

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, false);
	});

	it("PR lookup rejects but create succeeds → success, exactly one create", async () => {
		const { calls: notifyCalls, notify } = makeNotify();
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => {
					throw new Error("network error");
				},
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
			notify,
		});

		assert.equal(result.success, true);
		assert.equal(portCalls.filter((c) => c.method === "createPullRequest").length, 1);
		const surfaced = notifyCalls.filter((n) => n.message.includes("PR conflict check failed"));
		assert.equal(surfaced.length, 1, "one lookup-failure notification surfaced");
	});
});

// ─── handlePostAgentSuccess() wiring ─────────────────────────────

describe("handlePostAgentSuccess() — developer PR upsert wiring", () => {
	it("operator journey: commit+push then PR with in-progress body, returns true", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{ code: 0, stdout: "", stderr: "" }, // git diff --cached (nothing staged)
			{ code: 0, stdout: "up-to-date", stderr: "" }, // git push
			{ code: 0, stdout: "2\n", stderr: "" }, // git rev-list --count
		]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			new ErrorCollector(),
			undefined,
			makeNotify().notify,
			port,
			[developerResult],
		);

		assert.equal(ok, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		const input = creates[0]!.args[0] as { body: string };
		assert.ok(input.body.includes("Pipeline In Progress"));
		assert.ok(input.body.includes("Closes #42"));
	});

	it("commitAndPush failure → no PR call, returns false", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "fatal: could not add" }]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		assert.equal(ok, false);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("non-developer agents never upsert a PR", async () => {
		for (const agentName of ["architect", "test-designer", "researcher"]) {
			const portCalls: PortCall[] = [];
			const port = createMockGitHubPort({}, portCalls);
			const ok = await handlePostAgentSuccess(
				createMockPi([]),
				createMockCtx(),
				{ ...baseRunResult, agentName },
				agentName,
				42,
				mockConfig,
				emptyFilteredData,
				"/repo/worktree",
				"worktree-git-issue-42-test",
				"Test issue",
				undefined,
				undefined,
				undefined,
				port,
				[developerResult],
			);
			assert.equal(ok, true);
			assert.equal(prCalls(portCalls).length, 0, `${agentName} must not touch PRs`);
		}
	});

	it("developer with worktreeBranch undefined → no PR calls, returns true", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const ok = await handlePostAgentSuccess(
			createMockPi([]),
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		assert.equal(ok, true);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("legacy 14-arg call site (no agentResults) still resolves; empty agent table", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "up-to-date", stderr: "" },
			{ code: 0, stdout: "1\n", stderr: "" },
		]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(ok, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		assert.ok((creates[0]!.args[0] as { body: string }).body.includes("| (none) |"));
	});

	it("agentResults are tabulated in the PR body", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "up-to-date", stderr: "" },
			{ code: 0, stdout: "1\n", stderr: "" },
		]);

		await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		const body = (
			portCalls.filter((c) => c.method === "createPullRequest")[0]!.args[0] as {
				body: string;
			}
		).body;
		assert.ok(body.includes("| developer |"), "developer entry rendered");
		assert.ok(body.includes("✓ SUCCESS"), "status rendered");
	});
});

// ─── Structural pins ─────────────────────────────────────────────

const SUPERVISOR_DIR = join(__dirname, "../..");

function read(relPath: string): string {
	return readFileSync(join(SUPERVISOR_DIR, relPath), "utf-8");
}

describe("ordering + router pins (AC1)", () => {
	it("agent-loop.ts calls handlePostAgentSuccess before runPreTransitionHooks", () => {
		const src = read("pipeline/handler/agent-loop.ts");
		const postIdx = src.indexOf("handlePostAgentSuccess(");
		const gateIdx = src.indexOf("runPreTransitionHooks(");
		assert.ok(postIdx >= 0, "handlePostAgentSuccess call present");
		assert.ok(gateIdx >= 0, "runPreTransitionHooks call present");
		assert.ok(postIdx < gateIdx, "PR upsert runs before the pre-audit gates");
	});

	it("handlePostAgentSuccess delegates the upsert and stays a router", () => {
		const src = read("pipeline/stages/post-agent-success.ts");
		assert.ok(src.includes("upsertDeveloperPr"), "upsert delegated to the stage");
		const devBranchIdx = src.indexOf('agentName === "developer"');
		const upsertIdx = src.indexOf("await upsertDeveloperPr(");
		assert.ok(devBranchIdx >= 0 && upsertIdx > devBranchIdx, "upsert inside the developer branch");
		for (const forbidden of [
			"listPullRequestsForBranch",
			"createPullRequest",
			"buildPipelineSummary",
		]) {
			assert.ok(!src.includes(forbidden), `router must not reference ${forbidden}`);
		}
	});

	it("stages barrel re-exports upsertDeveloperPr explicitly", () => {
		const src = read("pipeline/stages/index.ts");
		assert.ok(src.includes("upsertDeveloperPr"), "barrel exports the stage");
		assert.ok(!src.includes("export *"), "no wildcard re-exports");
	});

	it("developer agent contract unchanged (AC4)", () => {
		const src = read("agents/developer.md");
		assert.ok(src.includes("**NEVER**"));
		assert.ok(src.includes("create pull requests"));
		assert.ok(src.includes("do NOT run git commands"));
	});
});
