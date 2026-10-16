// ─── Tests: trust-independent rejection discovery + fail-closed gate ──
// Issue #2044 audit findings #1 and #3:
//   #1 — the auditor's prior rejection must be discoverable even when the
//        automation account is not a codeowner (so it never reaches the
//        trust-filtered `comments` list).
//   #3 — a label-read failure must not silently bypass the rejection limit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import { assembleAgentTask, loadLoopIssue } from "../../pipeline/handler/agent-loop-steps.ts";
import type { FilteredIssueData, SupervisorConfig } from "../../config/types.ts";
import type { RawIssueData } from "../../lib/issue-filter.ts";
import type { WorkflowStep } from "../../config/workflow.ts";

const MARK = "<!-- supervisor:audit-rejection -->";

const config: SupervisorConfig = {
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

function buildRunContext(opts: {
	comments?: Array<{ author: { login: string }; body: string; id?: string }>;
	getIssueLabels?: (issueNum: number, repo: string) => Promise<string[]>;
	listComments?: (issueNum: number, repo: string) => Promise<NonNullable<RawIssueData["comments"]>>;
	getAuthenticatedLogin?: () => Promise<string>;
}): RunContext {
	const rawComments = opts.comments ?? [];
	return {
		args: undefined,
		ctx: {
			cwd: "/repo",
			ui: { notify: () => {}, setStatus: () => {} },
		} as unknown as ExtensionCommandContext,
		pi: {} as ExtensionAPI,
		issueNum: 42,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async () => ({
			code: 0,
			stdout: JSON.stringify({
				number: 42,
				title: "Test issue",
				body: "body",
				author: { login: "user1" },
				comments: rawComments,
			}),
			stderr: "",
		})) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config,
		port: createMockGitHubPort({
			getIssueLabels: opts.getIssueLabels,
			listComments: opts.listComments,
			getAuthenticatedLogin: opts.getAuthenticatedLogin,
		}),
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: { number: 42, title: "Test issue", body: "body", comments: rawComments },
		stageState: {
			loopStatus: "Audit",
			lastAuditScore: null,
			auditCycleCount: 0,
			duplicateCodeResult: null,
			researcherSkipped: false,
			deadCodeResult: null,
			vulnResult: null,
			gateFailureHistory: [],
		},
		loopStatus: "Audit",
		loopItem: { id: "item-1" },
		fields: [],
		statusField: { id: "status-field-id", name: "Status", type: "single_select" },
		projectId: "project-1",
		worktreePath: "/repo/wt",
		worktreeBranch: "worktree-git-issue-42-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
	} as unknown as RunContext;
}

// ─── assembleAgentTask() — prior rejection discovery ─────────────

describe("assembleAgentTask() — trust-independent prior rejection (finding #1)", () => {
	const rejectionData: FilteredIssueData = {
		body: "body",
		// Automation account is NOT a codeowner → the rejection is absent here.
		comments: [{ author: "user1", body: "unrelated" }],
		auditRejections: [{ id: "IC_bot", body: `## Audit Rejected\n\nstill broken\n\n${MARK}` }],
	};

	it("injects the re-verify block for the auditor from auditRejections", async () => {
		const task = await assembleAgentTask(buildRunContext({}), "auditor", rejectionData, undefined);
		assert.ok(
			task.includes("Prior Rejection — Re-verify Against Current Code"),
			"auditor gets the re-verify block",
		);
		assert.ok(task.includes("still broken"), "prior findings are embedded");
	});

	it("injects the fix-list block for the developer from auditRejections", async () => {
		const task = await assembleAgentTask(
			buildRunContext({}),
			"developer",
			rejectionData,
			undefined,
		);
		assert.ok(task.includes("AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION"));
		assert.ok(task.includes("still broken"));
	});

	it("injects an unmarked pre-marker rejection into the auditor re-verify block", async () => {
		// Upgrade path (issue #2044 audit finding): a rejection posted before the
		// marker existed is still the prior rejection the auditor must re-verify.
		const data: FilteredIssueData = {
			body: "body",
			comments: [],
			auditRejections: [{ id: "IC_legacy", body: "## Audit Rejected\n\nlegacy finding" }],
		};
		const task = await assembleAgentTask(buildRunContext({}), "auditor", data, undefined);
		assert.ok(task.includes("Prior Rejection — Re-verify Against Current Code"));
		assert.ok(task.includes("legacy finding"));
	});

	it("does not treat an unmarked comment heading as audit feedback", async () => {
		const data: FilteredIssueData = {
			body: "body",
			comments: [{ author: "user1", body: "## Audit Rejected\n\nmanual note" }],
		};
		const task = await assembleAgentTask(buildRunContext({}), "auditor", data, undefined);
		assert.ok(!task.includes("Re-verify Against Current Code"));
	});
});

// ─── loadLoopIssue() — fail closed on label-read failure ─────────

describe("loadLoopIssue() — fail-closed rejection counter (finding #3)", () => {
	const step: WorkflowStep = { status: "Audit", agentName: "auditor", maxRejections: 3 };

	it("stops the loop when labels cannot be read and a limit is configured", async () => {
		const runCtx = buildRunContext({
			getIssueLabels: async () => {
				throw new Error("503 Service Unavailable");
			},
		});
		const resolution = await loadLoopIssue(runCtx, step);
		assert.equal(resolution.kind, "terminal");
		assert.ok(
			resolution.kind === "terminal" && resolution.stopReason.includes("Cannot read issue labels"),
		);
	});

	it("proceeds when no rejection limit is configured", async () => {
		const runCtx = buildRunContext({
			getIssueLabels: async () => {
				throw new Error("503 Service Unavailable");
			},
		});
		const resolution = await loadLoopIssue(runCtx, { status: "Audit", agentName: "auditor" });
		assert.equal(resolution.kind, "loaded");
	});
});

// ─── loadLoopIssue() — fail closed on incomplete discovery ───────
// Issue #2044 audit findings #1 and #2: an incomplete comment listing or an
// unresolvable automation identity must stop the loop, not proceed as if no
// prior rejection existed.

describe("loadLoopIssue() — fail-closed discovery (findings #1/#2)", () => {
	const step: WorkflowStep = { status: "Audit", agentName: "auditor", maxRejections: 3 };

	it("stops the loop when comment listing fails", async () => {
		const runCtx = buildRunContext({
			listComments: async () => {
				throw new Error("503 Service Unavailable");
			},
		});
		const resolution = await loadLoopIssue(runCtx, step);
		assert.equal(resolution.kind, "terminal");
		assert.ok(
			resolution.kind === "terminal" && resolution.stopReason.includes("Cannot list all comments"),
		);
	});

	it("stops the loop when the automation login cannot be resolved", async () => {
		const runCtx = buildRunContext({
			getAuthenticatedLogin: async () => {
				throw new Error("403 Forbidden");
			},
		});
		const resolution = await loadLoopIssue(runCtx, step);
		assert.equal(resolution.kind, "terminal");
		assert.ok(
			resolution.kind === "terminal" && resolution.stopReason.includes("authenticated login"),
		);
	});
});
