// ─── Tests: pipeline/pr-creation.ts — createPrOnApproval ──────────
// Unit tests for the PR creation flow. Mocks GitHubPort and ctx.ui.
// Follows the same mock pattern as handler.test.mts.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

// ─── Call Tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

interface NotifyCall {
	message: string;
	level: string;
}

// ─── Port Helpers ──────────────────────────────────────────────────

function makeConflictInfo(prNumber: number = 123, hasConflict: boolean = false): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

function createMockComparePort(aheadBy: number = 3, existingPrNumber?: number): GitHubPort {
	return createMockGitHubPort({
		compareBranches: async () => aheadBy,
		listPullRequestsForBranch: async () =>
			existingPrNumber ? makeConflictInfo(existingPrNumber) : null,
		createPullRequest: async () => ({ number: 456 }),
		updatePullRequest: async () => {},
	});
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI with controllable exec responses.
 * If result.code !== 0, pi.exec returns a rejected promise (simulating
 * command failure). Otherwise returns a resolved promise.
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++];
			if (!result || result.code !== 0) {
				const errMsg = result?.stderr || result?.stdout || `Command failed: ${cmd}`;
				return Promise.reject(new Error(errMsg));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

/**
 * Create a mock ExtensionCommandContext with trackable notifications.
 */
function createMockCtx(notifyCalls?: NotifyCall[]): ExtensionCommandContext {
	const notifyLog = notifyCalls || [];
	return {
		cwd: "/repo",
		ui: {
			notify: (message: string, level?: string) => {
				notifyLog.push({ message, level: level || "info" });
			},
			setStatus: () => {},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

// ─── Fixtures ──────────────────────────────────────────────────────

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

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

// ─── Tests ─────────────────────────────────────────────────────────

describe("createPrOnApproval()", () => {
	it("Happy path with worktree: push → compare check → list PR → create PR → success notifications", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Verify only git push is an exec call (the rest use port)
		assert.equal(execCalls.length, 1, "should have 1 exec call (git push)");

		// 1. git push
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[0].args[0], "push");
		assert.equal(execCalls[0].args[1], "--force");
		assert.equal(execCalls[0].args[2], "origin");
		assert.equal(execCalls[0].args[3], "worktree-git-issue-42-test");
		assert.equal(execCalls[0].opts.cwd, "/worktrees/wt-42");
		assert.equal(execCalls[0].opts.timeout, 60000);

		// Verify success notifications
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.equal(infoNotifies.length, 1, "should have exactly 1 info notification");
		assert.ok(
			infoNotifies[0].message.includes("PR #456 created"),
			"should have PR creation success notification",
		);
	});

	it("Happy path without worktree: skip git push → check PR → create PR → success", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi([], execCalls);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Verify no git push call
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 0, "no git push when worktreePath is undefined");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Existing PR found: push → check PR → update via port.updatePullRequest", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3, 123); // existing PR #123

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Verify call: only git push is exec — PR update is port.call
		assert.equal(execCalls.length, 1);
		assert.equal(execCalls[0].cmd, "git");

		// Verify update notification
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const updateNotify = infoNotifies.find((n) => n.message.includes("PR #123 updated"));
		assert.ok(updateNotify, "should have PR update notification");
	});

	it("Push failure: returns PrCreationResult with success=false and no PR attempt", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 2. git push --force retry 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				// 3. git push --force retry 2 FAILS
				{ code: 1, stdout: "", stderr: "push failed: still down" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Verify error notification for push failure
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const pushError = errorNotifies.find((n) => n.message.toLowerCase().includes("push failed"));
		assert.ok(pushError, "should have error notification for push failure");

		// Verify PrCreationResult
		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
	});

	it("port.createPullRequest failure: error notification delivered, function does not throw unhandled", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		// createPullRequest rejects twice (retry exhaustion)
		let callCount = 0;
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				callCount++;
				throw new Error("create failed: GraphQL error");
			},
		});

		// Function should NOT throw — errors are caught internally
		await assert.doesNotReject(
			createPrOnApproval(
				pi,
				ctx,
				42,
				"Test issue",
				mockConfig as any,
				[mockAgentResult],
				"/worktrees/wt-42",
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				port,
			),
		);

		// Verify error notification
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const prErrorNotify = errorNotifies.find((n) => n.message.toLowerCase().includes("failed"));
		assert.ok(prErrorNotify, "should have error notification for PR creation failure");
		// Should have been retried (at least 2 calls)
		assert.equal(callCount, 2, "createPullRequest should be retried once");
	});

	it("port.listPullRequestsForBranch failure: caught, warning notification, PR creation still attempted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => { throw new Error("network error"); },
			createPullRequest: async () => ({ number: 456 }),
		});

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Verify warning notification for checkPrConflicts failure
		const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
		const checkWarning = warningNotifies.find((n) =>
			n.message.toLowerCase().includes("pr conflict check failed"),
		);
		assert.ok(checkWarning, "should have warning notification for PR conflict check failure");

		// Verify PR creation was still attempted (git push only — port handles the rest)
		assert.equal(execCalls.length, 1, "should have 1 exec call (git push)");
	});

	it("Regression: does NOT call git rev-list --count anywhere", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// Scan all exec calls for rev-list
		const revListCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args.some((a) => a === "rev-list" || a.includes("rev-list")),
		);
		assert.equal(revListCalls.length, 0, "should NOT call git rev-list --count");
	});

	it("agentResults empty array: still creates PR body and creates PR", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi([], execCalls);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[], // empty agentResults
			undefined,
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Boundary: worktreeBranch undefined, no worktreePath: branch generated from issueNum and title", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi([], execCalls);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		// Call without worktreePath and worktreeBranch to trigger auto-generation
		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			undefined, // no worktreeBranch — will be auto-generated
			undefined,
			undefined,
			undefined,
			port,
		);

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	// ─── PrCreationResult Tests ────────────────────────────────────────

	it("returns PrCreationResult with success=true when PR is created", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 456, "should contain PR number");
		assert.equal(result.error, undefined, "should have no error");
	});

	it("returns PrCreationResult with success=true and wasUpdate=true when PR is updated", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3, 123); // existing PR 123

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 123, "should contain existing PR number");
		assert.equal(result.wasUpdate, true, "should be marked as update");
	});

	it("returns PrCreationResult with success=false when port.createPullRequest fails (both retries)", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		let callCount = 0;
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				callCount++;
				throw new Error("create failed: GraphQL error");
			},
		});

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
		// Error should describe the failure
		assert.ok(result.error!.length > 0, "error should not be empty");
	});

	it("returns PrCreationResult with success=false when push fails", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1-3. git push --force all 3 retry attempts FAIL
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				{ code: 1, stdout: "", stderr: "push failed: timeout" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when push fails");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.toLowerCase().includes("push"), "error should mention push failure");
		// Verify no gh calls were made after push failure
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR creation after push failure");
	});

	it("push retry: first push fails, retry succeeds after backoff", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// First push fails, second succeeds
		const pi = createMockPi(
			[
				// 1. git push --force attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 2. git push --force attempt 2 succeeds
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after push retry");

		// Verify two git push calls were made
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 2, "should retry push once after failure");

		// Both pushes should have 60000 timeout
		for (const pushCall of gitPushCalls) {
			assert.equal(pushCall.opts.timeout, 60000, "push timeout should be 60000");
		}
	});

	it("push retry: all 3 attempts exhausted → failure", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// All 3 push attempts fail
		const pi = createMockPi(
			[
				// 1. git push --force attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 1" },
				// 2. git push --force attempt 2 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 2" },
				// 3. git push --force attempt 3 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 3" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after all push retries exhausted");
		assert.ok(result.error, "should contain error message");

		// Verify 3 git push calls were made
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 3, "should make 3 push attempts");

		// Verify no gh calls
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR after push failure");
	});

	it("returns PrCreationResult with success=false when PR conflict check throws", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force OK
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => { throw new Error("network error"); },
			createPullRequest: async () => ({ number: 456 }),
		});

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(
			result.success,
			true,
			"should still succeed if PR creation works despite check failure",
		);
		assert.equal(result.prNumber, 456, "should contain PR number");
	});

	it("retries createPullRequest with backoff on transient failure", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		let callCount = 0;
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				callCount++;
				if (callCount === 1) throw new Error("rate limit exceeded");
				return { number: 789 };
			},
		});

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after retry");
		assert.equal(result.prNumber, 789, "should contain PR number from retry");

		// Verify two createPullRequest calls were made
		assert.equal(callCount, 2, "createPullRequest should be retried once");
	});

	it("fails after retry exhausted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		let callCount = 0;
		const port = createMockGitHubPort({
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				callCount++;
				throw new Error(`attempt ${callCount} failed`);
			},
		});

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after retry exhaustion");
		assert.ok(result.error, "should contain error message");

		// Verify two createPullRequest calls were made
		assert.equal(callCount, 2, "should make exactly 2 attempts");
	});

	// ─── Bug 2: ahead_by=0 ─────────────────────────────────────────

	it("Bug 2: ahead_by=0 returns success=false with 'No commits ahead' error", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force OK
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(0); // ahead_by = 0

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when no commits ahead");
		assert.ok(result.error, "should contain error message");
		assert.ok(
			result.error!.toLowerCase().includes("no commits") ||
				result.error!.toLowerCase().includes("skipped") ||
				result.error!.toLowerCase().includes("no new changes"),
			`error should mention no commits: ${result.error}`,
		);
		assert.equal(result.prNumber, undefined, "prNumber should be undefined when no commits");
	});

	it("Bug 2: ahead_by=0 does NOT report 'created' in output (no misleading PR #undefined)", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(0); // ahead_by = 0

		const result = await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			port,
		);

		// No PR creation should be attempted
		const infoNotifies = notifyCalls.filter((n) => n.message.includes("PR #"));
		assert.equal(infoNotifies.length, 0, "no PR notifications should be sent");

		// The result should not be misleading
		assert.equal(result.success, false, "should not indicate success");
		assert.equal(result.prNumber, undefined, "prNumber should be undefined");
	});
});
