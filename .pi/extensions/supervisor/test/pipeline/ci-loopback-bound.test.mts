// ─── Tests: bounded CI loop-back + terminal blocker (issue #1829) ─
// A red CI returns the issue to Implementation, counts toward the shared
// `maxRejections` budget (the `reject-N` label), and stops with a blocker
// comment once the budget is spent.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/ci-loopback-bound.test.mts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, FilteredIssueData } from "../../config/types.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import type { StageState } from "../../pipeline/stages/index.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import { REJECTION_LIMIT, WORKFLOW } from "../../config/workflow.ts";
import { runPreTransitionHooks } from "../../pipeline/handler/agent-loop-helpers.ts";
import { loadLoopIssue } from "../../pipeline/handler/agent-loop-steps.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import type { GitHubPort } from "../../github/ports.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const CONFIG: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
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

const ISSUE = 1829;
const WT = "/wt/issue-1829";
const BRANCH = "worktree-git-issue-1829-test";
const CI_NOTE = "--- CI Gate (failing: build) ---\nCI checks failing: build.";

const IMPLEMENTATION_STEP = WORKFLOW.find((s) => s.status === "Implementation")!;

interface NotifyCall {
	message: string;
	level: string;
}

function buildRunCtx(opts: {
	stageState?: StageState;
	port?: GitHubPort;
	labels?: string[];
	issueView?: { code: number; stdout: string };
	collector?: ErrorCollector;
	notifyCalls?: NotifyCall[];
}): RunContext {
	const notifyCalls = opts.notifyCalls ?? [];
	const labels = opts.labels ?? [];
	const port =
		opts.port ??
		createMockGitHubPort({
			getIssueLabels: async () => [...labels],
			listComments: async () => [],
		});
	const issueView = opts.issueView ?? {
		code: 0,
		stdout: JSON.stringify({
			number: ISSUE,
			title: "bounded CI loop-back",
			body: "body",
			author: { login: "user1" },
			comments: [],
		}),
	};

	return {
		args: undefined,
		ctx: {
			cwd: "/repo",
			ui: {
				notify: (message: string, level: string) => notifyCalls.push({ message, level }),
				setStatus: () => {},
			},
		} as unknown as ExtensionCommandContext,
		pi: {
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			sendMessage: () => {},
		} as unknown as ExtensionAPI,
		issueNum: ISSUE,
		isDebug: false,
		exec: (async (cmd: string) =>
			cmd === "gh"
				? { code: issueView.code, stdout: issueView.stdout, stderr: "" }
				: { code: 0, stdout: "", stderr: "" }) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: opts.collector ?? new ErrorCollector(),
		config: CONFIG,
		port,
		issueTitle: "bounded CI loop-back",
		filteredData: { body: "body", comments: [] },
		issueData: {},
		stageState: opts.stageState ?? createStageState("Implementation"),
		loopStatus: "Implementation",
		loopItem: { id: "item-1" } as RunContext["loopItem"],
		fields: [],
		statusField: { id: "status-field-id" } as RunContext["statusField"],
		projectId: "project-1",
		worktreePath: WT,
		worktreeBranch: BRANCH,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
	} as unknown as RunContext;
}

const DATA: FilteredIssueData = { body: "body", comments: [] };

// ─── Phase 5a: runPreTransitionHooks outcome ──────────────────────

describe("runPreTransitionHooks — CI loop-back recording (issue #1829)", () => {
	it("(use-case) CI failure → Implementation, one rejection recorded, context + history updated", async () => {
		const stageState = createStageState("Implementation");
		const runCtx = buildRunCtx({ stageState });
		const postCiGateRejectionFn = mock.fn(async () => 1);
		const runAuditFn = mock.fn(async () => ({
			nextStatus: "Implementation",
			note: CI_NOTE,
			ciFailureText: CI_NOTE,
		}));

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			2,
			{ runAuditFn: runAuditFn as never, postCiGateRejectionFn: postCiGateRejectionFn as never },
		);

		assert.deepEqual(outcome, { kind: "next", status: "Implementation" });
		assert.equal(postCiGateRejectionFn.mock.callCount(), 1, "the loop-back is counted once");
		assert.equal(stageState.gateFailureContext, CI_NOTE);
		assert.deepEqual(stageState.gateFailureHistory, [
			"CI Gate (failing: build) gate failed on run 2 — developer restarted",
		]);
	});

	it("(use-case) non-CI failure → Implementation with no rejection recorded", async () => {
		const stageState = createStageState("Implementation");
		const runCtx = buildRunCtx({ stageState });
		const postCiGateRejectionFn = mock.fn(async () => 1);
		const note = "--- TypeScript Checkpoint ---\n2 type errors";

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{
				runAuditFn: (async () => ({
					nextStatus: "Implementation",
					note,
					ciFailureText: null,
				})) as never,
				postCiGateRejectionFn: postCiGateRejectionFn as never,
			},
		);

		assert.deepEqual(outcome, { kind: "next", status: "Implementation" });
		assert.equal(postCiGateRejectionFn.mock.callCount(), 0, "a TSC failure adds no reject label");
		assert.equal(stageState.gateFailureContext, note);
	});

	it("(use-case) counter write failure → stop naming the failure, no re-dispatch", async () => {
		const notifyCalls: NotifyCall[] = [];
		const runCtx = buildRunCtx({ notifyCalls });

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{
				runAuditFn: (async () => ({
					nextStatus: "Implementation",
					note: CI_NOTE,
					ciFailureText: CI_NOTE,
				})) as never,
				postCiGateRejectionFn: (async () => {
					throw new Error("labels unavailable");
				}) as never,
			},
		);

		assert.equal(outcome.kind, "stop");
		assert.match(
			(outcome as { stopReason: string }).stopReason,
			/labels unavailable/,
			"the stop reason names the failure",
		);
		assert.ok(
			runCtx.collector.all.some((r) => r.message.includes("labels unavailable")),
			"the failure reaches the collector",
		);
		assert.ok(
			notifyCalls.some((c) => c.level === "error"),
			"the stop is surfaced to the operator, never log-only",
		);
	});

	it("(use-case) all gates pass → Audit and the stale gate context is cleared", async () => {
		const stageState = createStageState("Implementation");
		stageState.gateFailureContext = "stale failure";
		const runCtx = buildRunCtx({ stageState });
		const postCiGateRejectionFn = mock.fn(async () => 1);

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			3,
			{
				runAuditFn: (async () => ({
					nextStatus: "Audit",
					note: "all gates passed",
					ciFailureText: null,
				})) as never,
				postCiGateRejectionFn: postCiGateRejectionFn as never,
			},
		);

		assert.deepEqual(outcome, { kind: "next", status: "Audit" });
		assert.equal(stageState.gateFailureContext, undefined);
		assert.equal(postCiGateRejectionFn.mock.callCount(), 0);
	});

	it("(use-case) CI block refreshes the PR body with the new gate-history entry", async () => {
		const stageState = createStageState("Implementation");
		const runCtx = buildRunCtx({ stageState });
		const upsertDeveloperPrFn = mock.fn(
			async (_deps: { gateFailureHistory?: string[] }) => ({ success: true, source: "developer-pr" }),
		);

		await runPreTransitionHooks(runCtx, IMPLEMENTATION_STEP, "Audit", "developer", DATA, 2, {
			runAuditFn: (async () => ({
				nextStatus: "Implementation",
				note: CI_NOTE,
				ciFailureText: CI_NOTE,
			})) as never,
			postCiGateRejectionFn: (async () => 1) as never,
			upsertDeveloperPrFn: upsertDeveloperPrFn as never,
		});

		assert.equal(upsertDeveloperPrFn.mock.callCount(), 1, "the PR body is refreshed once");
		const deps = upsertDeveloperPrFn.mock.calls[0]!.arguments[0] as {
			gateFailureHistory?: string[];
		};		assert.deepEqual(deps.gateFailureHistory, [
			"CI Gate (failing: build) gate failed on run 2 — developer restarted",
		]);
	});

	it("(use-case) PR refresh failure does not undo the loop-back", async () => {
		const stageState = createStageState("Implementation");
		const runCtx = buildRunCtx({ stageState });

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{
			runAuditFn: (async () => ({
				nextStatus: "Implementation",
				note: CI_NOTE,
				ciFailureText: CI_NOTE,
			})) as never,
			postCiGateRejectionFn: (async () => 1) as never,
			upsertDeveloperPrFn: (async () => {
				throw new Error("PR API down");
			}) as never,
		});

		assert.deepEqual(outcome, { kind: "next", status: "Implementation" });
		assert.ok(
			runCtx.collector.all.some((r) => r.message.includes("PR API down")),
			"the refresh failure is collected",
		);
	});
});

// ─── Phase 5b: loadLoopIssue — the one dispatch-time limit check ───

describe("loadLoopIssue — rejection budget covers CI loop-backs (issue #1829)", () => {
	it("(use-case) reject-5 on Implementation → terminal with a `## Rejection Limit Reached` blocker", async () => {
		const stageState = createStageState("Implementation");
		stageState.gateFailureContext = CI_NOTE;
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{ getIssueLabels: async () => [`reject-${REJECTION_LIMIT}`], listComments: async () => [] },
			calls,
		);
		const runCtx = buildRunCtx({ stageState, port });

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "terminal");
		assert.equal(
			(resolution as { stopReason: string }).stopReason,
			`Rejection limit reached (${REJECTION_LIMIT})`,
		);
		const blocker = calls.filter((c) => c.method === "postIssueComment");
		assert.equal(blocker.length, 1, "exactly one blocker comment");
		const body = String(blocker[0]!.args[2]);
		assert.ok(body.startsWith("## Rejection Limit Reached"), body);
		assert.ok(body.includes(String(REJECTION_LIMIT)), `the count is named: ${body}`);
		assert.ok(body.includes("CI Gate (failing: build)"), `the last gate note is named: ${body}`);
	});

	it("(use-case) reject-4 on Implementation → loaded, no blocker comment", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{ getIssueLabels: async () => ["reject-4"], listComments: async () => [] },
			calls,
		);
		const runCtx = buildRunCtx({ port });

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "loaded");
		assert.equal(calls.filter((c) => c.method === "postIssueComment").length, 0);
	});

	it("(use-case) blocker comment fails → still terminal, error surfaced via notify and collector", async () => {
		const notifyCalls: NotifyCall[] = [];
		const collector = new ErrorCollector();
		const port = createMockGitHubPort({
			getIssueLabels: async () => [`reject-${REJECTION_LIMIT}`],
			listComments: async () => [],
			postIssueComment: async () => {
				throw new Error("comment API down");
			},
		});
		const runCtx = buildRunCtx({ port, collector, notifyCalls });

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "terminal");
		assert.ok(
			notifyCalls.some((c) => c.level === "error"),
			"the failed blocker post is surfaced",
		);
		assert.ok(
			collector.all.some((r) => r.message.includes("comment API down")),
			"the collector carries the failure",
		);
	});

	it("(use-case) Implementation discovery failure → terminal (fail closed), same as Audit", async () => {
		const port = createMockGitHubPort({
			getIssueLabels: async () => [],
			listComments: async () => {
				throw new Error("cannot list comments");
			},
		});
		const runCtx = buildRunCtx({ port });

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "terminal");
		assert.match((resolution as { stopReason: string }).stopReason, /cannot list comments/);
	});

	it("(use-case) config.maxRejections 3 with reject-3 present → still loaded (effective limit is 5)", async () => {
		const port = createMockGitHubPort({
			getIssueLabels: async () => ["reject-3"],
			listComments: async () => [],
		});
		const runCtx = buildRunCtx({ port });

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "loaded", "the workflow limit wins over config.maxRejections");
	});
});

// ─── Phase 5c: the limit is one shared number ─────────────────────

describe("REJECTION_LIMIT — one budget for audit and CI loop-backs (issue #1829)", () => {
	it("(entity) REJECTION_LIMIT is 5 and both loop-back steps use it", () => {
		assert.equal(REJECTION_LIMIT, 5);
		const implementation = WORKFLOW.find((s) => s.status === "Implementation");
		const audit = WORKFLOW.find((s) => s.status === "Audit");
		assert.equal(implementation?.maxRejections, REJECTION_LIMIT);
		assert.equal(audit?.maxRejections, REJECTION_LIMIT);
	});
});
