// ─── Tests: PR body refresh at audit approval (issue #1831) ──────
// Five slices of the "one PR, refreshed at approval" contract:
//   1. The auditor verdict renders into the PR body (output/pr-creation).
//   2. createPrOnApproval takes one PrBodyInput instead of two positional
//      body fields and keeps exactly one publisher (upsert).
//   3. handlePrApprovalFlow sequences publish → readiness gate → final
//      status refresh, and never creates a duplicate PR.
//   4. A PR that vanishes after a successful publish is re-published once
//      ("vanished" mergeability mode) instead of failing open.
//   5. The auditor verdict is captured at post-dispatch bookkeeping.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	AuditorVerdictSummary,
	PipelineAgentResult,
	PrConflictInfo,
} from "../../config/types.ts";
import { buildPrBody, createPrOnApproval } from "../../pipeline/pr-creation.ts";
import { buildPipelineSummary, renderAuditorSection } from "../../pipeline/output.ts";
import {
	classifyMergeability,
	handleMissingPr,
	type PrGateDeps,
	type RoundState,
} from "../../pipeline/pr-gate.ts";
import { ensurePrReadyForDone } from "../../pipeline/merge.ts";
import { handlePrApprovalFlow } from "../../pipeline/handler/pr-gates.ts";
import { recordPostDispatch } from "../../pipeline/handler/agent-loop-steps.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import type { PortCall } from "../helper/mock-github-port.ts";

// ─── Shared fixtures ─────────────────────────────────────────────

const REPO = "owner/repo";
const BRANCH = "worktree-git-issue-42-test";
const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };

const GATE_ENTRY = "CI Gate (failing: build) gate failed on run 2 — developer restarted";

const mockConfig = {
	repo: REPO,
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
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	agentTimeoutsMin: {},
};

const agentResults: PipelineAgentResult[] = [
	{ agentName: "developer", status: "SUCCESS", durationMs: 1000, tokenCount: 100, toolCount: 3 },
];

const AUDIT_VERDICT: AuditorVerdictSummary = {
	score: { passing: 7, total: 9 },
	blockers: [
		{ severity: "critical", dimension: "tests-passed" },
		{ severity: "warning", dimension: "code-quality" },
	],
};

const PACKAGE_SAFETY = {
	status: "safe" as const,
	results: [{ packageName: "left-pad", ageDays: 3000, safe: true, blocked: false, message: "ok" }],
};

function makeCleanInfo(prNumber = 456): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeDirtyInfo(prNumber = 456): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict: true,
		mergeable: "CONFLICTING",
		mergeStateStatus: "DIRTY",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeUnknownInfo(prNumber = 456): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict: false,
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

type ExecResult = { code: number; stdout: string; stderr: string; killed?: boolean };

/** Mock ExtensionAPI matching the real pi.exec contract (always resolves). */
function createMockPi(results: ExecResult[] = []) {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const exec = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: args ?? [] });
		return Promise.resolve(results.shift() ?? { code: 0, stdout: "", stderr: "" });
	}) as unknown as ExtensionAPI["exec"];
	const api = {
		exec,
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
	return { pi: api, execCalls: calls };
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

/** Port whose listPullRequestsForBranch walks a scripted sequence. */
function createSequencedPort(
	sequence: Array<PrConflictInfo | null>,
	calls: PortCall[],
	overrides: Parameters<typeof createMockGitHubPort>[0] = {},
) {
	let idx = 0;
	return createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => sequence[idx++] ?? null,
			...overrides,
		},
		calls,
	);
}

function bodyOf(call: PortCall | undefined): string {
	if (!call) return "";
	const arg = call.args[0];
	if (arg && typeof arg === "object" && "body" in arg) {
		return String((arg as { body?: string }).body ?? "");
	}
	return String(call.args[2] ?? "");
}

// ─── Phase 1: body renders the auditor verdict ───────────────────

describe("Phase 1 — auditor verdict rendering (output.ts / pr-creation.ts)", () => {
	it("renderAuditorSection states the score and lists critical+warning dimensions", () => {
		const section = renderAuditorSection(AUDIT_VERDICT);

		assert.ok(section.includes("7/9"), `section must carry the score: ${section}`);
		assert.ok(section.includes("critical"), "critical severity rendered");
		assert.ok(section.includes("tests-passed"), "critical dimension rendered");
		assert.ok(section.includes("warning"), "warning severity rendered");
		assert.ok(section.includes("code-quality"), "warning dimension rendered");
	});

	it("blockers that are not critical/warning are excluded (summary-only contract)", () => {
		const section = renderAuditorSection({
			score: { passing: 9, total: 9 },
			blockers: [{ severity: "suggestion" as unknown as "critical", dimension: "completeness" }],
		});

		assert.ok(section.includes("9/9"), "score still rendered");
		assert.ok(!section.includes("completeness"), `suggestion dropped: ${section}`);
	});

	it("empty blockers → score line rendered, no bullet list", () => {
		const section = renderAuditorSection({ score: { passing: 9, total: 9 }, blockers: [] });

		assert.ok(section.includes("9/9"));
		assert.ok(!section.includes("\n- "), `no bullets for an empty blocker list: ${section}`);
	});

	it("auditVerdict undefined → no auditor section in the body", () => {
		const { body } = buildPrBody(42, "Test issue", agentResults, mockConfig as never, {
			overallStatus: "success",
		});

		assert.ok(!/auditor/i.test(body), `no auditor section expected: ${body}`);
	});

	it("success + auditVerdict → Pipeline Complete header plus auditor section", () => {
		const { body } = buildPrBody(42, "Test issue", agentResults, mockConfig as never, {
			overallStatus: "success",
			auditVerdict: AUDIT_VERDICT,
		});

		assert.ok(body.includes("## ✅ Pipeline Complete"), "success header rendered");
		assert.ok(body.includes("7/9"), "auditor score rendered");
		assert.ok(body.includes("tests-passed"), "auditor blocker rendered");
	});

	it("early upsert shape (in-progress, no verdict) → In Progress header, no auditor section", () => {
		const { body } = buildPrBody(42, "Test issue", agentResults, mockConfig as never, {
			overallStatus: "in-progress",
			gateFailureHistory: [GATE_ENTRY],
		});

		assert.ok(body.includes("## 🚧 Pipeline In Progress"), "in-progress header rendered");
		assert.ok(!/auditor/i.test(body), `no auditor section before approval: ${body}`);
	});

	it("regression: buildPipelineSummary keeps its positional contract (gate history + package safety)", () => {
		const summary = buildPipelineSummary(
			agentResults,
			"success",
			42,
			"Test issue",
			mockConfig as never,
			undefined,
			undefined,
			[GATE_ENTRY],
			PACKAGE_SAFETY,
		);

		assert.ok(summary.includes(GATE_ENTRY), "gate failure history rendered positionally");
		assert.ok(summary.includes("**Package safety:**"), "package safety rendered positionally");
	});
});

// ─── Phase 2: single publisher takes PrBodyInput ─────────────────

const REBASE_OK_ROUND: ExecResult[] = [
	{ code: 0, stdout: "fetch ok", stderr: "" },
	{ code: 0, stdout: "rebase ok", stderr: "" },
	{ code: 0, stdout: "push ok", stderr: "" },
];

function approvalCall(
	pi: ExtensionAPI,
	port: ReturnType<typeof createMockGitHubPort>,
	bodyInput?: Parameters<typeof createPrOnApproval>[9],
) {
	return createPrOnApproval(
		pi,
		createMockCtx(),
		42,
		"Test issue",
		mockConfig as never,
		agentResults,
		"/worktrees/wt-42",
		BRANCH,
		undefined,
		bodyInput,
		port,
	);
}

describe("Phase 2 — createPrOnApproval takes one PrBodyInput (pr-creation.ts)", () => {
	it("existing PR on the branch → exactly 1 update, 0 creates (AC1)", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		const port = createSequenceExisting(calls);

		const result = await approvalCall(pi, port, { overallStatus: "success" });

		assert.equal(result.success, true);
		assert.equal(result.wasUpdate, true, "existing PR is updated, not re-created");
		assert.equal(calls.filter((c) => c.method === "updatePullRequest").length, 1);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
	});

	function createSequenceExisting(calls: PortCall[]) {
		return createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => makeCleanInfo(),
				updatePullRequest: async () => {},
			},
			calls,
		);
	}

	it("no existing PR → exactly 1 create (create path preserved)", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 789 }),
			},
			calls,
		);

		const result = await approvalCall(pi, port, { overallStatus: "success" });

		assert.equal(result.success, true);
		assert.equal(result.prNumber, 789);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 1);
	});

	it("PrBodyInput fields all reach the body handed to updatePullRequest", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => makeCleanInfo(),
				updatePullRequest: async () => {},
			},
			calls,
		);

		await approvalCall(pi, port, {
			overallStatus: "success",
			gateFailureHistory: [GATE_ENTRY],
			packageSafetyResult: PACKAGE_SAFETY,
			auditVerdict: AUDIT_VERDICT,
		});

		const body = String(calls.find((c) => c.method === "updatePullRequest")?.args[2] ?? "");
		assert.ok(body.includes(GATE_ENTRY), "gate failure history kept");
		assert.ok(body.includes("**Package safety:**"), "package safety kept");
		assert.ok(body.includes("7/9"), "auditor verdict kept");
	});

	it("push failure (all retries) → success:false, zero PR writes", async () => {
		const calls: PortCall[] = [];
		const failing: ExecResult[] = [
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "rebase ok", stderr: "" },
			{ code: 1, stdout: "", stderr: "rejected" },
			{ code: 0, stdout: "prune ok", stderr: "" },
			{ code: 1, stdout: "", stderr: "rejected" },
			{ code: 0, stdout: "prune ok", stderr: "" },
			{ code: 1, stdout: "", stderr: "rejected" },
		];
		const { pi } = createMockPi(failing);
		const port = createMockGitHubPort({ compareBranches: async () => 3 }, calls);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>>;
		try {
			const promise = approvalCall(pi, port, { overallStatus: "success" });
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			await flushQueue();
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result.success, false);
		assert.ok(result.error?.includes("rejected"), "push stderr excerpt propagated");
		assert.equal(
			calls.filter((c) => c.method === "createPullRequest" || c.method === "updatePullRequest")
				.length,
			0,
			"zero PR writes after a failed push",
		);
	});

	it("port unavailable → success:false with 'GitHubPort not available', zero PR writes", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		createMockGitHubPort({}, calls);

		const result = await createPrOnApproval(
			pi,
			createMockCtx(),
			42,
			"Test issue",
			mockConfig as never,
			agentResults,
			"/worktrees/wt-42",
			BRANCH,
			undefined,
			{ overallStatus: "success" },
			undefined,
		);

		assert.equal(result.success, false);
		assert.ok(
			result.error?.includes("GitHubPort not available"),
			`error mentions the missing port: ${result.error}`,
		);
		assert.equal(calls.length, 0, "no port calls without a port");
	});
});

function flushQueue(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// ─── Phase 3: approval sequences publish → gate → refresh ────────

const FIELDS = [
	{
		id: "status-field-id",
		name: "Status",
		type: "single_select",
		options: [
			{ id: "opt-implementation", name: "Implementation" },
			{ id: "opt-audit", name: "Audit" },
			{ id: "opt-done", name: "Done" },
		],
	},
];
const STATUS_FIELD = FIELDS[0]!;

function buildRunContext(
	port: ReturnType<typeof createMockGitHubPort>,
	pi: ExtensionAPI,
	overrides: Partial<RunContext> = {},
): RunContext {
	const ctx = createMockCtx();
	return {
		args: undefined,
		ctx,
		pi,
		issueNum: 42,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: mockConfig as never,
		port,
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: { number: 42, title: "Test", body: "b", author: { login: "u" }, comments: [] },
		stageState: createStageState("Audit"),
		loopStatus: "Audit",
		loopItem: { id: "item-1" },
		fields: FIELDS as never,
		statusField: STATUS_FIELD as never,
		projectId: "project-1",
		worktreePath: "/worktrees/wt-42",
		worktreeBranch: BRANCH,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults,
		auditVerdict: AUDIT_VERDICT,
		...overrides,
	} as unknown as RunContext;
}

describe("Phase 3 — handlePrApprovalFlow sequences publish → gate → refresh", () => {
	it("existing clean PR + audit verdict → { stop: false }, 1 update, 0 creates, final body complete", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		const port = createSequencedPort([makeCleanInfo(), makeCleanInfo(), makeCleanInfo()], calls);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, false);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
		const updates = calls.filter((c) => c.method === "updatePullRequest");
		assert.equal(updates.length, 1, "the existing PR is updated once");
		const body = String(updates[0]?.args[2] ?? "");
		assert.ok(body.includes("## ✅ Pipeline Complete"), "success header at approval");
		assert.ok(body.includes("7/9"), "auditor verdict appended at approval");
	});

	it("blocked gate → one extra update with the stopped status; no duplicate PR (AC2)", async () => {
		const calls: PortCall[] = [];
		// 1 upsert list (PR exists) + 3 rounds × (list + poll) — auto-merge
		// succeeds every round but the PR never settles → gate blocks.
		const sequence = [
			makeCleanInfo(),
			makeDirtyInfo(),
			makeDirtyInfo(),
			makeDirtyInfo(),
			makeDirtyInfo(),
			makeDirtyInfo(),
			makeDirtyInfo(),
		];
		const autoMergeRound: ExecResult[] = [
			{ code: 0, stdout: "fetch ok", stderr: "" }, // approval rebase fetch
			{ code: 0, stdout: "rebase ok", stderr: "" }, // approval rebase
			{ code: 0, stdout: "push ok", stderr: "" }, // approval push
			// 3 × tryAutoMerge (fetch, merge, push)
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "merge ok", stderr: "" },
			{ code: 0, stdout: "push ok", stderr: "" },
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "merge ok", stderr: "" },
			{ code: 0, stdout: "push ok", stderr: "" },
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "merge ok", stderr: "" },
			{ code: 0, stdout: "push ok", stderr: "" },
		];
		const { pi } = createMockPi(autoMergeRound);
		const port = createSequencedPort(sequence, calls);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, true, "gate blocks Done");
		if (outcome.stop) {
			assert.equal(outcome.loopStatus, "Implementation");
		}
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0, "no duplicate");
		const updates = calls.filter((c) => c.method === "updatePullRequest");
		assert.equal(updates.length, 2, "approval body + one final-status refresh");
		const finalBody = String(updates[1]?.args[2] ?? "");
		assert.ok(finalBody.includes("## ⏹ Pipeline Stopped"), `stopped header: ${finalBody}`);
		assert.ok(
			finalBody.includes("**Stopped at:** PR readiness verification did not settle"),
			`stop reason from the gate: ${finalBody}`,
		);
		assert.ok(finalBody.includes("7/9"), "auditor verdict survives the refresh");
		const comments = calls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("PR Readiness Blocked")),
			"blocker comment posted",
		);
	});

	it("AC3 fallback: PR vanishes at the gate → one bounded upsert retry → gate passes with the new PR", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND, ...REBASE_OK_ROUND]);
		let created = 0;
		// Invisible through the whole publish/re-publish window, then the
		// replacement PR settles clean on the gate's next round.
		const port = createSequencedPort(
			[null, null, null, null, makeCleanInfo(902), makeCleanInfo(902)],
			calls,
			{ createPullRequest: async () => ({ number: 900 + ++created }) },
		);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, false, "the gate still passes after re-publishing");
		assert.equal(outcome.prCreationResult?.prNumber, 902, "retried publish owns the PR number");
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 2);
	});

	it("AC3 fallback retry also fails → { stop: true }, Implementation, blocker comment, no Done", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND, ...REBASE_OK_ROUND]);
		let created = 0;
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => {
					if (created++ === 0) return { number: 900 };
					// "already exists" + failing re-list → fail fast, no retry delay
					throw new Error("Validation Failed: A pull request already exists for branch");
				},
			},
			calls,
		);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, true, "no PR → never Done");
		if (outcome.stop) {
			assert.equal(outcome.loopStatus, "Implementation");
			assert.ok(
				outcome.prCreationResult && !outcome.prCreationResult.success,
				"failed publish propagated",
			);
		}
		const comments = calls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("PR Readiness Blocked")),
			"blocker comment posted",
		);
		const transitions = calls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(!transitions.includes("opt-done"), "never transitions to Done");
	});

	it("approval publish fails but an earlier PR is clean → body rewritten, then { stop: false }", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		let updates = 0;
		const port = createSequencedPort(
			[makeCleanInfo(), makeCleanInfo(), makeCleanInfo(), makeCleanInfo()],
			calls,
			{
				updatePullRequest: async () => {
					updates++;
					if (updates === 1) throw new Error("gh: secondary rate limit");
				},
			},
		);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		// Audit finding: a failed approval publish must never complete with the
		// in-progress body — the body is republished before Done.
		assert.equal(outcome.stop, false);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
		const bodyWrites = calls.filter((c) => c.method === "updatePullRequest");
		assert.equal(bodyWrites.length, 2, "failed publish + one body re-publish");
		const finalBody = bodyOf(bodyWrites[bodyWrites.length - 1]);
		assert.ok(finalBody.includes("## ✅ Pipeline Complete"), `final body: ${finalBody}`);
		assert.ok(finalBody.includes("7/9"), "auditor verdict present in the republished body");
	});

	it("approval body cannot be published at all → { stop: true }, no Done, blocker posted", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([...REBASE_OK_ROUND]);
		const port = createSequencedPort(
			[makeCleanInfo(), makeCleanInfo(), makeCleanInfo(), makeCleanInfo()],
			calls,
			{
				updatePullRequest: async () => {
					throw new Error("gh: 500 Internal Server Error");
				},
			},
		);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, true, "no confirmed body → never Done");
		if (outcome.stop) assert.equal(outcome.loopStatus, "Implementation");
		assert.equal(
			calls.filter((c) => c.method === "createPullRequest").length,
			0,
			"no duplicate PR",
		);
		const comments = calls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some(
				(b) => b.includes("PR Readiness Blocked") && b.includes("body could not be published"),
			),
			"blocker comment names the body failure",
		);
		const transitions = calls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(!transitions.includes("opt-done"), "never transitions to Done");
	});

	it("dirty PR → auto-merge → re-poll clean → { stop: false } (readiness gate unchanged)", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([
			...REBASE_OK_ROUND,
			{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
			{ code: 0, stdout: "merge ok", stderr: "" }, // tryAutoMerge merge
			{ code: 0, stdout: "push ok", stderr: "" }, // resolveBranchConflicts push
		]);
		const port = createSequencedPort(
			[makeCleanInfo(), makeDirtyInfo(), makeDirtyInfo(), makeCleanInfo(), makeCleanInfo()],
			calls,
		);
		const runCtx = buildRunContext(port, pi);

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, false);
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 0);
	});

	it("no port at approval → { stop: true } with the GitHubPort blocker (fail-closed)", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([]);
		const runCtx = buildRunContext(undefined as never, pi);
		runCtx.port = undefined as never;

		const outcome = await handlePrApprovalFlow(runCtx, "Audit");

		assert.equal(outcome.stop, true);
		if (outcome.stop) {
			assert.equal(outcome.loopStatus, "Implementation");
			assert.ok(
				outcome.prCreationResult === undefined || !outcome.prCreationResult.success,
				"no successful publish without a port",
			);
		}
		assert.equal(calls.length, 0);
	});
});

// ─── Phase 4: vanished-PR rule ───────────────────────────────────

function makeGateDeps(
	port: ReturnType<typeof createMockGitHubPort>,
	pi: ExtensionAPI,
	overrides: Partial<PrGateDeps> = {},
): PrGateDeps {
	return {
		pi,
		ctx: createMockCtx(),
		issueNum: 42,
		issueTitle: "Test issue",
		config: mockConfig as never,
		agentResults: [],
		worktreePath: undefined,
		worktreeBranch: BRANCH,
		collector: undefined,
		runner: undefined,
		port,
		prBody: { overallStatus: "success", auditVerdict: AUDIT_VERDICT },
		...overrides,
	};
}

describe("Phase 4 — vanished-PR rule (pr-gate.ts)", () => {
	it("classifyMergeability(null, successful publish) → no-pr vanished", () => {
		assert.deepEqual(classifyMergeability(null, { success: true, prNumber: 123 }), {
			kind: "no-pr",
			mode: "vanished",
		});
	});

	it("classifyMergeability(null, undefined) → still propagating (fail-open for stateless callers)", () => {
		assert.deepEqual(classifyMergeability(null, undefined), {
			kind: "no-pr",
			mode: "propagating",
		});
	});

	it("classifyMergeability boundary: failed results keep rebase-conflicts / creation-failed", () => {
		assert.deepEqual(classifyMergeability(null, { success: false, rebaseConflicts: ["a"] }), {
			kind: "no-pr",
			mode: "rebase-conflicts",
		});
		assert.deepEqual(classifyMergeability(null, { success: false }), {
			kind: "no-pr",
			mode: "creation-failed",
		});
		assert.deepEqual(classifyMergeability(null, { success: false, rebaseConflicts: [] }), {
			kind: "no-pr",
			mode: "creation-failed",
		});
	});

	it("classifyMergeability: clean / dirty / computing unchanged", () => {
		assert.deepEqual(classifyMergeability(makeCleanInfo(), { success: true }), {
			kind: "clean",
			prNumber: 456,
		});
		assert.deepEqual(classifyMergeability(makeDirtyInfo(), { success: true }), {
			kind: "dirty",
			prNumber: 456,
		});
		assert.deepEqual(classifyMergeability(makeUnknownInfo(), { success: true }), {
			kind: "computing",
		});
	});

	it("vanished: PR appears during the bounded poll → { ok: true }, polls capped at 3", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[makeUnknownInfo(), makeUnknownInfo(), makeCleanInfo()],
			calls,
		);
		const { pi } = createMockPi([]);
		const state: RoundState = { current: { success: true, prNumber: 456 }, retried: false };

		const outcome = await handleMissingPr(
			makeGateDeps(port, pi),
			state,
			BRANCH,
			NO_BACKOFF,
			"vanished",
		);

		assert.ok("verdict" in outcome && outcome.verdict.ok, "settled PR passes the gate");
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			3,
			"poll capped at min(attempts, 3)",
		);
		assert.equal(state.retried, false, "no retry needed when the PR reappears");
	});

	it("vanished: PR stays invisible → one bounded re-publish, then back to the gate rounds", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "rebase ok", stderr: "" },
			{ code: 0, stdout: "push ok", stderr: "" },
		]);
		const port = createSequencedPort([null, null], calls, {
			listPullRequestsForBranch: undefined,
			compareBranches: async () => 3,
			createPullRequest: async () => ({ number: 777 }),
		});
		const state: RoundState = { current: { success: true, prNumber: 456 }, retried: false };

		const outcome = await handleMissingPr(
			makeGateDeps(port, pi, { worktreePath: "/worktrees/wt-42" }),
			state,
			BRANCH,
			NO_BACKOFF,
			"vanished",
		);

		// The replacement PR is NOT trusted yet: the gate must re-poll its
		// mergeability instead of passing on the bare create response (audit #1).
		assert.ok("continue" in outcome, "the gate rounds continue to verify the new PR");
		assert.equal(state.current?.prNumber, 777, "re-published PR owns the new number");
		assert.equal(calls.filter((c) => c.method === "createPullRequest").length, 1);
		assert.equal(state.retried, true, "the retry is recorded as used");
	});

	it("vanished: re-published PR must settle clean before the gate passes", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([]);
		// round 0: list → null → vanished; poll → null; the re-publish's own
		// list → null → create #777; round 1: the replacement PR is dirty.
		const port = createSequencedPort(
			[null, null, null, makeDirtyInfo(777), makeDirtyInfo(777)],
			calls,
			{ createPullRequest: async () => ({ number: 777 }) },
		);

		const verdict = await ensurePrReadyForDone(
			pi,
			createMockCtx(),
			42,
			"Test issue",
			mockConfig as never,
			agentResults,
			undefined,
			BRANCH,
			{ success: true, prNumber: 456 },
			undefined,
			port,
			undefined,
			NO_BACKOFF,
			{ overallStatus: "success", auditVerdict: AUDIT_VERDICT },
		);

		assert.equal(verdict.ok, false, "a dirty replacement PR never passes the Done gate");
		assert.ok(
			verdict.blockerNote?.includes("manual intervention"),
			`blockerNote explains the block: ${verdict.blockerNote}`,
		);
	});

	it("vanished: re-publish fails → { ok: false } with a manual-intervention blocker", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([
			{ code: 0, stdout: "fetch ok", stderr: "" },
			{ code: 0, stdout: "rebase ok", stderr: "" },
			{ code: 0, stdout: "push ok", stderr: "" },
		]);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => {
					throw new Error("Validation Failed: A pull request already exists for branch");
				},
			},
			calls,
		);
		const state: RoundState = { current: { success: true, prNumber: 456 }, retried: false };

		const outcome = await handleMissingPr(
			makeGateDeps(port, pi, { worktreePath: "/worktrees/wt-42" }),
			state,
			BRANCH,
			NO_BACKOFF,
			"vanished",
		);

		assert.ok("verdict" in outcome);
		assert.equal(outcome.verdict.ok, false, "no PR → the gate blocks");
		assert.ok(
			outcome.verdict.blockerNote?.includes("Manual intervention"),
			`blockerNote mentions manual intervention: ${outcome.verdict.blockerNote}`,
		);
		assert.equal(outcome.verdict.prCreationResult?.success, false, "failed publish propagated");
	});

	it("vanished after an earlier retry → { ok: false } immediately, no second retry", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const { pi } = createMockPi([]);
		const state: RoundState = { current: { success: true, prNumber: 456 }, retried: true };

		const outcome = await handleMissingPr(
			makeGateDeps(port, pi),
			state,
			BRANCH,
			NO_BACKOFF,
			"vanished",
		);

		assert.ok("verdict" in outcome);
		assert.equal(outcome.verdict.ok, false, "bounded: never retries twice");
		assert.equal(calls.length, 0, "no port calls after the retry budget is spent");
	});

	it("ensurePrReadyForDone threads PrBodyInput into the retried publish body", async () => {
		const calls: PortCall[] = [];
		const { pi } = createMockPi([]);
		let createdBody = "";
		const port = createSequencedPort(
			// The re-published PR (#555) is visible and clean on the next round.
			[null, null, null, makeCleanInfo(555), makeCleanInfo(555)],
			calls,
			{
				createPullRequest: async (input: { body?: string }) => {
					createdBody = String(input.body ?? "");
					return { number: 555 };
				},
			},
		);

		const verdict = await ensurePrReadyForDone(
			pi,
			createMockCtx(),
			42,
			"Test issue",
			mockConfig as never,
			agentResults,
			undefined,
			BRANCH,
			{ success: true, prNumber: 456 },
			undefined,
			port,
			undefined,
			NO_BACKOFF,
			{
				overallStatus: "success",
				gateFailureHistory: [GATE_ENTRY],
				packageSafetyResult: PACKAGE_SAFETY,
				auditVerdict: AUDIT_VERDICT,
			},
		);

		assert.equal(verdict.ok, true, "the re-published PR passes the gate");
		assert.equal(verdict.prCreationResult?.prNumber, 555);
		// One PrBodyInput carried through the retry: no field may be dropped
		// (pins the `retryCreatePr` undefined drift fix).
		assert.ok(
			createdBody.includes("7/9"),
			`retried body keeps the auditor section: ${createdBody}`,
		);
		assert.ok(
			createdBody.includes(GATE_ENTRY),
			`retried body keeps the gate failure history: ${createdBody}`,
		);
		assert.ok(
			createdBody.includes("Package safety"),
			`retried body keeps the package safety result: ${createdBody}`,
		);
	});
});

// ─── Phase 5: audit verdict captured at post-dispatch ────────────

function auditorResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	const structured = JSON.stringify({
		action: "APPROVED",
		agentName: "auditor",
		summary: "Audit approved",
		commentBody: "## Audit Approved",
		auditScore: { passing: 8, total: 9 },
		findings: [
			{
				severity: "critical",
				dimension: "tests-passed",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "warning",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "suggestion",
				dimension: "completeness",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		],
	});
	return {
		output: structured,
		success: true,
		agentName: "auditor",
		toolCount: 3,
		tokenCount: 1000,
		durationMs: 5000,
		textOutput: structured,
		textOnly: structured,
		summaryLine: "Audit approved",
		errorOutput: "",
		...overrides,
	};
}

describe("Phase 5 — audit verdict captured at post-dispatch (agent-loop-steps.ts)", () => {
	it("auditor result → auditVerdict { score 8/9, blockers critical+warning } (suggestion dropped)", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			stageState: createStageState("Audit"),
			auditVerdict: undefined,
		});

		recordPostDispatch(runCtx, "auditor", auditorResult(), 1);

		assert.deepEqual(runCtx.auditVerdict, {
			score: { passing: 8, total: 9 },
			blockers: [
				{ severity: "critical", dimension: "tests-passed" },
				{ severity: "warning", dimension: "code-quality" },
			],
		});
	});

	it("auditor result without structured output → verdict stays undefined, no throw", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			auditVerdict: undefined,
		});
		const textOnly = auditorResult({
			output: "Audit done\nAUDIT_SCORE: 8/9",
			textOutput: "Audit done\nAUDIT_SCORE: 8/9",
			textOnly: "Audit done\nAUDIT_SCORE: 8/9",
		});

		recordPostDispatch(runCtx, "auditor", textOnly, 1);

		assert.equal(runCtx.auditVerdict, undefined);
	});

	it("text-only audit after a structured audit clears the stale verdict", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			stageState: createStageState("Audit"),
			auditVerdict: undefined,
		});
		recordPostDispatch(runCtx, "auditor", auditorResult(), 1);
		assert.ok(runCtx.auditVerdict, "first structured audit captured");

		const textOnly = auditorResult({
			output: "Audit done\nAUDIT_SCORE: 8/9",
			textOutput: "Audit done\nAUDIT_SCORE: 8/9",
			textOnly: "Audit done\nAUDIT_SCORE: 8/9",
		});
		recordPostDispatch(runCtx, "auditor", textOnly, 2);

		// A dispatch without a structured verdict must not leave the previous
		// dispatch's findings in the PR body as if they were current (audit #3).
		assert.equal(runCtx.auditVerdict, undefined);
	});

	it("failed auditor dispatch after a structured audit clears the verdict too", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			stageState: createStageState("Audit"),
			auditVerdict: undefined,
		});
		recordPostDispatch(runCtx, "auditor", auditorResult(), 1);
		assert.ok(runCtx.auditVerdict, "first structured audit captured");

		recordPostDispatch(runCtx, "auditor", auditorResult({ success: false }), 2);

		assert.equal(runCtx.auditVerdict, undefined);
	});

	it("non-auditor dispatch → verdict stays undefined", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			auditVerdict: undefined,
		});

		recordPostDispatch(runCtx, "developer", auditorResult({ agentName: "developer" }), 1);

		assert.equal(runCtx.auditVerdict, undefined);
	});

	it("regression: gateRejected / refusedOutput unchanged for the same inputs", () => {
		const runCtx = buildRunContext(createMockGitHubPort(), createMockPi([]).pi, {
			stageState: createStageState("Audit"),
			auditVerdict: undefined,
		});

		const record = recordPostDispatch(runCtx, "auditor", auditorResult(), 1);

		assert.equal(record.refusedOutput, null, "structured approval is not a refusal");
		assert.ok(record.gateRejected === undefined || typeof record.gateRejected === "object");
	});
});
