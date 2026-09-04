// ─── Tests: pipeline/pr-creation.ts — createPrOnApproval ──────────
// Unit tests for the PR creation flow. Mocks GitHubPort and ctx.ui.
// Follows the same mock pattern as handler.test.mts.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import type { PortCall } from "../helper/mock-github-port.ts";
import { readFileSync } from "node:fs";

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
 * Mock ExtensionAPI matching the REAL pi.exec contract: always RESOLVES
 * {code, stdout, stderr, killed} — never rejects on non-zero exit
 * (pi-core execCommand resolves {code} even for failed commands).
 * The push-failure gate must read result.code/killed, not try/catch.
 */
function createResolvingPi(
	results: Array<{ code: number; stdout: string; stderr: string; killed?: boolean }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++] ?? { code: 0, stdout: "", stderr: "" };
			return Promise.resolve({ killed: false, ...result });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

/**
 * Drain the microtask queue (setImmediate fires only once the microtask
 * queue is empty) so a pending mock-timer retry delay can be ticked. Node 22
 * MockTimers has no tickAsync — tick() is synchronous, so each delay needs
 * flush → tick → flush.
 */
function flushQueue(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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
	it("Happy path first run: compareBranches returns ahead_by=3 BEFORE push → rebase (fetch + rebase) → push with --force-with-lease → PR created", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push --force-with-lease (ahead_by=3, push proceeds)
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

		// Verify exec call order: fetch → rebase → push
		assert.equal(execCalls.length, 3, "should have 3 exec calls (fetch, rebase, push)");

		// 1. git fetch
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[0].args[0], "fetch");
		assert.equal(execCalls[0].args[1], "origin");
		assert.equal(execCalls[0].args[2], "main");

		// 2. git rebase --autostash
		assert.equal(execCalls[1].cmd, "git");
		assert.equal(execCalls[1].args[0], "rebase");
		assert.equal(execCalls[1].args[1], "--autostash");
		assert.equal(execCalls[1].args[2], "origin/main");

		// 3. git push uses --force-with-lease
		assert.equal(execCalls[2].cmd, "git");
		assert.equal(execCalls[2].args[0], "push");
		assert.equal(execCalls[2].args[1], "--force-with-lease");
		assert.equal(execCalls[2].args[2], "origin");
		assert.equal(execCalls[2].args[3], "worktree-git-issue-42-test");
		assert.equal(execCalls[2].opts.cwd, "/worktrees/wt-42");
		assert.equal(execCalls[2].opts.timeout, 60000);

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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push
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

		// Verify exec call order: fetch → rebase → push
		assert.equal(execCalls.length, 3, "should have 3 exec calls (fetch, rebase, push)");
		assert.equal(execCalls[0].args[0], "fetch");
		assert.equal(execCalls[1].args[0], "rebase");
		assert.equal(execCalls[2].args[0], "push");

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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push --force FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 4. git push --force retry 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				// 5. git push --force retry 2 FAILS
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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push
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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push
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

		// Verify PR creation was still attempted (3 exec: fetch → rebase → push)
		assert.equal(execCalls.length, 3, "should have 3 exec calls (fetch, rebase, push)");
	});

	it("Regression: does NOT call git rev-list --count anywhere", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push
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
			undefined, // no worktreePath — skips Phase 2 and 2.5
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
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
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
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
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
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3-5. git push --force all 3 retry attempts FAIL
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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push --force attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 4. lease refresh before retry
				{ code: 0, stdout: "prune ok", stderr: "" },
				// 5. git push --force attempt 2 succeeds
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

		// Verify two git push calls were made (after fetch + rebase)
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
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3-5. git push --force all 3 retry attempts FAIL
				{ code: 1, stdout: "", stderr: "push failed: error 1" },
				// lease refresh before retry 2
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "push failed: error 2" },
				// lease refresh before retry 3
				{ code: 0, stdout: "prune ok", stderr: "" },
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

		// Verify 3 git push calls were made (after fetch + rebase)
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 3, "should make 3 push attempts");

		// Verify no gh calls
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR after push failure");
	});

	// ─── Push failure gate (pi.exec resolves {code} — never rejects) ───
	// Issue #1613: a failed push resolved normally, logged "Push OK", set
	// pushSucceeded=true, and the pipeline updated/created a PR against a
	// remote branch that was never updated. These tests use the always-
	// resolve mock (real pi.exec contract) so they fail on the pre-fix code.

	it("push {code:1} stderr excerpt ×3 → 3 push attempts, failure, zero PR lifecycle calls", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const portCalls: PortCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "error: failed to push some refs" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "error: failed to push some refs" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "error: failed to push some refs" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
				updatePullRequest: async () => {},
			},
			portCalls,
		);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		// 3 real push attempts, each preceded on retry by a lease-refresh fetch
		const pushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		const pruneCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "--prune");
		assert.equal(pushCalls.length, 3, "should make exactly 3 push attempts");
		assert.equal(pruneCalls.length, 2, "lease refresh before each retry");

		// Failure contract: {success:false}, stderr excerpt in error + notify
		assert.equal(result!.success, false, "failed push must not report success");
		assert.ok(result!.error!.includes("error: failed to push some refs"), "error embeds stderr excerpt");
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		assert.ok(
			errorNotifies.some((n) => n.message.includes("push failed") && n.message.includes("failed to push some refs")),
			"error notification delivered with stderr excerpt",
		);

		// Phase 4/5 unreachable — no PR lifecycle calls on failed push
		const prLifecycle = portCalls.filter((c) =>
			["listPullRequestsForBranch", "createPullRequest", "updatePullRequest"].includes(c.method),
		);
		assert.equal(prLifecycle.length, 0, "zero PR lifecycle calls after failed push");
	});

	it("push {code:0, killed:true} ×3 (timeout kill) → same failure contract", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "", killed: true },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "", killed: true },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "", killed: true },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, false, "timeout-killed push (code 0) must still fail");
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		assert.ok(errorNotifies.some((n) => n.message.includes("push failed")), "error notification delivered");
	});

	it("boundary: attempt 3 {code:0, killed:true} → still {success:false} (killed gate independent of attempt count)", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rejected" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rejected" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "", killed: true },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, false, "killed on final attempt must still fail");
		const pushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(pushCalls.length, 3, "3 push attempts made");
	});

	it("push {code:128} fatal transport error ×3 → failure with 'fatal' excerpt", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 128, stdout: "", stderr: "fatal: unable to access" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 128, stdout: "", stderr: "fatal: unable to access" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 128, stdout: "", stderr: "fatal: unable to access" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, false, "transport failure must not report success");
		assert.ok(result!.error!.includes("fatal: unable to access"), "error embeds fatal excerpt");
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		assert.ok(errorNotifies.some((n) => n.message.includes("fatal: unable to access")), "notify carries fatal excerpt");
	});

	it("retry wiring: push {code:1} stale-info → git fetch --prune → push {code:0} → retry succeeds, PR created once", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const portCalls: PortCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "! [rejected] main -> main (stale info)" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 0, stdout: "push ok", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
				updatePullRequest: async () => {},
			},
			portCalls,
		);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, true, "retry with refreshed lease should succeed");
		assert.equal(result!.prNumber, 456, "PR created once");

		// Order: rebase fetch, rebase, push, fetch --prune, push — prune BEFORE retry push
		const seq = execCalls.map((c) => ({ cmd: c.cmd, args: c.args, opts: c.opts }));
		assert.deepEqual(seq[0].args.slice(0, 3), ["fetch", "origin", "main"], "rebase fetch first");
		assert.equal(seq[1].args[0], "rebase", "rebase second");
		assert.equal(seq[2].args[0], "push", "push attempt 1 third");
		assert.deepEqual(seq[3].args, ["fetch", "--prune", "origin"], "lease refresh precedes retry");
		assert.equal(seq[3].opts?.cwd, "/worktrees/wt-42", "prune runs in the worktree");
		assert.equal(seq[4].args[0], "push", "push attempt 2 fifth");

		const createCalls = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 1, "PR created exactly once after successful retry");
	});

	it("boundary: retry fetch --prune {code:128} → attempt fails; 3 attempts → {success:false}", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "rejected" },
				{ code: 128, stdout: "", stderr: "fatal: unable to access" },
				{ code: 1, stdout: "", stderr: "rejected" },
				{ code: 128, stdout: "", stderr: "fatal: unable to access" },
				{ code: 1, stdout: "", stderr: "rejected" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, false, "failed lease refresh must not set pushSucceeded");
		assert.ok(
			result!.error!.includes("git fetch --prune origin failed"),
			"prune failure surfaces in the error",
		);
		// Each retry fails at the lease refresh (prune precedes push), so only
		// attempt 1 reaches the push; 2 prune retries prove the loop iterated.
		const pushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		const pruneCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "--prune");
		assert.equal(pushCalls.length, 1, "only attempt 1 reaches the push");
		assert.equal(pruneCalls.length, 2, "lease refresh attempted on both retries");
	});

	it("boundary: push {code:1} with empty stderr/stdout → fallback error, never 'Push OK'", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createResolvingPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "" },
				{ code: 0, stdout: "prune ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);
		const port = createMockComparePort(3);

		mock.timers.enable({ apis: ["setTimeout"] });
		let result: Awaited<ReturnType<typeof createPrOnApproval>> | undefined;
		try {
			const promise = createPrOnApproval(
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
			await flushQueue();
			mock.timers.tick(3000);
			await flushQueue();
			mock.timers.tick(5000);
			result = await promise;
		} finally {
			mock.timers.reset();
		}

		assert.equal(result!.success, false, "code 1 with empty output still fails");
		assert.ok(
			result!.error!.includes("git push failed (exit 1)"),
			"fallback message used when stderr/stdout empty",
		);
	});

	it("returns PrCreationResult with success=false when PR conflict check throws", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git fetch origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. git rebase --autostash origin/main (rebase Phase 2.5)
				{ code: 0, stdout: "rebase ok", stderr: "" },
				// 3. git push
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
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
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
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
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

	// ─── Bug 2 (fix): ahead_by=0 checked before push ────────────────

	it("Bug 2 (fix): ahead_by=0 — push skipped, pushSkipped=true, no git push exec calls", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// No mock exec results needed — ahead_by check runs first and returns early
		const pi = createMockPi([], execCalls);
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

		// No git push exec calls should be made
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 0, "no git push should be called when ahead_by=0");

		// Result should indicate failure with pushSkipped
		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when no commits ahead");
		assert.equal(result.pushSkipped, true, "pushSkipped should be true when ahead_by=0");
		assert.ok(result.error, "should contain error message");
		assert.ok(
			result.error!.toLowerCase().includes("no new changes") ||
				result.error!.toLowerCase().includes("no changes"),
			`error should mention no changes: ${result.error}`,
		);
		assert.equal(result.prNumber, undefined, "prNumber should be undefined when no commits");
	});

	it("Bug 2 (fix): ahead_by=0 — no misleading PR notifications, pushSkipped=true", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi([], execCalls);
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

		// No PR creation should be attempted — no "PR #" notifications
		const infoNotifies = notifyCalls.filter((n) => n.message.includes("PR #"));
		assert.equal(infoNotifies.length, 0, "no PR notifications should be sent");

		// The result should not be misleading
		assert.equal(result.success, false, "should not indicate success");
		assert.equal(result.prNumber, undefined, "prNumber should be undefined");
		assert.equal(result.pushSkipped, true, "pushSkipped should be true");
	});

	describe("createPrOnApproval - Phase reorder: ahead_by check before push — Bug fix", () => {
		it("Re-run with reconciliation (remote ahead): ahead_by=3 → rebase → push → existing PR updated", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
					{ code: 0, stdout: "push ok", stderr: "" },
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockComparePort(3, 123); // ahead_by=3, existing PR

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

			assert.equal(result.success, true, "should succeed");
			assert.equal(result.prNumber, 123, "should return existing PR number");
			assert.equal(result.wasUpdate, true, "should be marked as update");
			assert.equal(result.pushSkipped, undefined, "pushSkipped should be undefined when push proceeds");

			const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
			assert.equal(gitPushCalls.length, 1, "push should be called once");
			assert.equal(gitPushCalls[0].args[1], "--force-with-lease", "push should use --force-with-lease");

			// Verify exec call order: fetch → rebase → push
			assert.equal(execCalls.length, 3, "should have 3 exec calls");
			assert.equal(execCalls[0].args[0], "fetch");
			assert.equal(execCalls[1].args[0], "rebase");
			assert.equal(execCalls[2].args[0], "push");
		});

		it("compareBranches throws → local fallback: fetch + merge-base succeeds, head is ahead → push proceeds", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					// Phase 2 fallback: fetch + merge-base
					{ code: 0, stdout: "", stderr: "" },  // git fetch origin <branch>
					{ code: 0, stdout: "", stderr: "" },  // git merge-base --is-ancestor exits 0
					// Phase 2.5: rebase
					{ code: 0, stdout: "fetch ok", stderr: "" },  // git fetch origin main
					{ code: 0, stdout: "rebase ok", stderr: "" },  // git rebase --autostash
					// Phase 3: push
					{ code: 0, stdout: "push ok", stderr: "" },  // git push --force-with-lease
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => { throw new Error("API rate limit"); },
				listPullRequestsForBranch: async () => null,
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

			assert.equal(result.success, true, "should succeed after fallback check passes");
			assert.equal(result.pushSkipped, undefined, "pushSkipped should be undefined when push proceeds");

			// Verify exec call order: fetch (phase 2) → merge-base → fetch (phase 2.5) → rebase → push
			assert.equal(execCalls.length, 5, "should have 5 exec calls (fetch, merge-base, fetch, rebase, push)");
			assert.ok(execCalls[0].args.includes("fetch"), "first should be git fetch (phase 2)");
			assert.ok(execCalls[1].args.includes("merge-base"), "second should be git merge-base");
			assert.ok(execCalls[2].args.includes("fetch"), "third should be git fetch (phase 2.5)");
			assert.ok(execCalls[3].args.includes("rebase"), "fourth should be git rebase");
			assert.ok(execCalls[4].args.includes("push"), "fifth should be git push");
			assert.equal(execCalls[4].args[1], "--force-with-lease", "push should use --force-with-lease");
		});

		it("compareBranches throws → local fallback: merge-base says NOT ahead → push skipped", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "", stderr: "" },  // git fetch succeeds
					{ code: 1, stdout: "", stderr: "" },  // git merge-base exits 1 (NOT ancestor)
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => { throw new Error("API rate limit"); },
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

			assert.equal(result.success, false, "should fail when merge-base says not ahead");
			assert.equal(result.pushSkipped, true, "pushSkipped should be true");

			const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
			assert.equal(gitPushCalls.length, 0, "no push should be called");
		});

		it("compareBranches throws → local fallback fetch fails → push skipped (fail-closed)", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 1, stdout: "", stderr: "fetch failed" },  // git fetch fails
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => { throw new Error("API rate limit"); },
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

			assert.equal(result.success, false, "should fail when fetch fails");
			assert.equal(result.pushSkipped, true, "pushSkipped should be true (fail-closed)");

			const errorNotifies = notifyCalls.filter((n) => n.level === "error");
			assert.ok(errorNotifies.length > 0, "should have error notification");
		});

		it("No worktree path: ahead_by check + push skipped, PR creation proceeds", async () => {
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
				undefined,
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				port,
			);

			const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
			assert.equal(gitPushCalls.length, 0, "no git push when worktreePath is undefined");

			const infoNotifies = notifyCalls.filter((n) => n.level === "info" && n.message.includes("PR #"));
			assert.ok(infoNotifies.length > 0, "should have PR notification");
		});

		it("--force-with-lease used in exec args instead of bare --force", async () => {
			const execCalls: ExecCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
					{ code: 0, stdout: "push ok", stderr: "" },
				],
				execCalls,
			);
			const ctx = createMockCtx([]);
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

			const pushCall = execCalls.find((c) => c.cmd === "git" && c.args[0] === "push");
			assert.ok(pushCall, "push should be called");
			assert.equal(pushCall!.args[1], "--force-with-lease", "should use --force-with-lease");
		});
	});

	// ─── Rebase orchestration tests ────────────────────────────────────

	describe("createPrOnApproval - Rebase orchestration: Phase 2.5", () => {
		it("Rebase success → push proceeds → PR created", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
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

			assert.ok(result.success, "should succeed");
			assert.equal(result.prNumber, 456, "should have PR number");
			// Verify call order: fetch → rebase → push
			assert.equal(execCalls.length, 3);
			assert.equal(execCalls[0].args[0], "fetch");
			assert.equal(execCalls[1].args[0], "rebase");
			assert.equal(execCalls[2].args[0], "push");
		});

		it("Rebase conflict → pushSkipped=true, rebaseConflicts populated, no push or PR", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					// 1. git fetch succeeds
					{ code: 0, stdout: "fetch ok", stderr: "" },
					// 2. git rebase --autostash FAILS (conflict)
					{ code: 1, stdout: "", stderr: "rebase conflict" },
					// 3. git diff --diff-filter=U returns conflicted files
					{ code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" },
					// 4. git rebase --abort
					{ code: 0, stdout: "", stderr: "" },
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

			assert.ok(!result.success, "should fail");
			assert.equal(result.pushSkipped, true, "pushSkipped should be true");
			assert.deepEqual(result.rebaseConflicts, ["src/a.ts", "src/b.ts"], "should report rebase conflict files");
			assert.equal(result.prNumber, undefined, "no PR number");

			// Verify warning notification with conflict file names
			const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
			const rebaseWarning = warningNotifies.find((n) =>
				n.message.includes("Rebase conflicts")
			);
			assert.ok(rebaseWarning, "should have warning notification for rebase conflicts");
			assert.ok(rebaseWarning!.message.includes("src/a.ts"), "warning should mention conflicted files");
			assert.ok(rebaseWarning!.message.includes("src/b.ts"), "warning should mention all conflicted files");

			// Verify no push or PR exec calls
			const pushCalls = execCalls.filter((c) => c.args[0] === "push");
			assert.equal(pushCalls.length, 0, "no push should be called after rebase conflict");
		});

		it("Rebase conflict → warning notification and PrCreationResult reflects rebase", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 1, stdout: "", stderr: "rebase conflict" },
					{ code: 0, stdout: "file1.ts\nfile2.ts\nfile3.ts\n", stderr: "" },
					{ code: 0, stdout: "", stderr: "" },
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

			assert.equal(result.success, false);
			assert.equal(result.pushSkipped, true);
			assert.equal(result.rebaseConflicts?.length, 3, "should have 3 rebase conflict files");
			assert.ok(result.rebaseConflicts?.includes("file1.ts"), "should include all conflict files");
		});

		it("Fetch failure (all retries) → pushSkipped=true, error notification, no push or PR", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					// 3 fetch attempts all fail
					{ code: 1, stdout: "", stderr: "fetch failed: network 1" },
					{ code: 1, stdout: "", stderr: "fetch failed: network 2" },
					{ code: 1, stdout: "", stderr: "fetch failed: network 3" },
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

			assert.ok(!result.success, "should fail");
			assert.equal(result.pushSkipped, true, "pushSkipped should be true");

			// Error notification should be sent
			const errorNotifies = notifyCalls.filter((n) => n.level === "error");
			const fetchError = errorNotifies.find((n) => n.message.includes("rebase"));
			assert.ok(fetchError, "should have error notification for rebase failure");

			// No push calls
			const pushCalls = execCalls.filter((c) => c.args[0] === "push");
			assert.equal(pushCalls.length, 0, "no push should be called");
		});

		it("No worktree path → no rebase exec calls, PR creation proceeds", async () => {
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
				undefined, // no worktreePath — skips Phase 2 and 2.5 and 3
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				port,
			);

			// No fetch or rebase calls should be made
			const gitCalls = execCalls.filter((c) => c.cmd === "git");
			assert.equal(gitCalls.length, 0, "no git calls when worktreePath is undefined");

			const infoNotifies = notifyCalls.filter((n) => n.level === "info" && n.message.includes("PR #"));
			assert.ok(infoNotifies.length > 0, "should have PR notification");
		});

		it("Ahead-by=0: returns early before rebase, pushSkipped=true, no rebaseConflicts", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi([], execCalls);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockComparePort(0);

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

			assert.equal(result.success, false);
			assert.equal(result.pushSkipped, true);
			assert.equal(result.rebaseConflicts, undefined, "rebaseConflicts should not be set when rebase not attempted");

			// No exec calls at all
			assert.equal(execCalls.length, 0, "no exec calls when ahead-by=0");
		});

		it("Rebase uses correct branch/remote args: git fetch origin main, git rebase --autostash origin/main", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
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

			assert.ok(result.success, "should succeed");

			// Verify correct args
			const fetchCall = execCalls[0];
			assert.equal(fetchCall.args[0], "fetch");
			assert.equal(fetchCall.args[1], "origin");
			assert.equal(fetchCall.args[2], "main");

			const rebaseCall = execCalls[1];
			assert.equal(rebaseCall.args[0], "rebase");
			assert.equal(rebaseCall.args[1], "--autostash");
			assert.equal(rebaseCall.args[2], "origin/main");

			const pushCall = execCalls[2];
			assert.equal(pushCall.args[0], "push");
			assert.equal(pushCall.args[1], "--force-with-lease");
		});

		it("Regression: push retry (3 attempts) still works when rebase succeeds", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
					{ code: 1, stdout: "", stderr: "push failed" },
					{ code: 0, stdout: "prune ok", stderr: "" },
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

			assert.ok(result.success, "should succeed after push retry");

			const pushCalls = execCalls.filter((c) => c.args[0] === "push");
			assert.equal(pushCalls.length, 2, "push should be retried once");
		});

		it("Regression: existing PR update path works when rebase succeeds", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
					{ code: 0, stdout: "push ok", stderr: "" },
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockComparePort(3, 789);

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

			assert.ok(result.success, "should succeed");
			assert.equal(result.prNumber, 789, "should reference existing PR");
			assert.equal(result.wasUpdate, true, "should be marked as update");
		});
	});
});

// ─── Structural: verifyAhead helper extraction (Issue #1377) ──────

describe("createPrOnApproval — structural: verifyAhead helper extraction", () => {
	const source = readFileSync(".pi/extensions/supervisor/pipeline/pr-creation.ts", "utf-8");

	it("contains async function verifyAhead with AheadVerdict return type", () => {
		assert.ok(
			source.includes("async function verifyAhead("),
			"pr-creation.ts must contain async function verifyAhead",
		);
		assert.ok(
			source.includes("Promise<AheadVerdict>"),
			"verifyAhead must return Promise<AheadVerdict>",
		);
	});

	it("AheadVerdict type includes 'ahead', 'not-ahead', 'fail-closed' states with reason on fail-closed", () => {
		assert.ok(
			source.includes('{ state: "ahead" }'),
			"AheadVerdict must include 'ahead' state",
		);
		assert.ok(
			source.includes('{ state: "not-ahead" }'),
			"AheadVerdict must include 'not-ahead' state",
		);
		assert.ok(
			source.includes('{ state: "fail-closed"; reason: string }'),
			"AheadVerdict must include 'fail-closed' state with reason: string",
		);
	});

	it("createPrOnApproval call site dispatches on verdict with 3 branches (ahead, not-ahead, fail-closed)", () => {
		const lines = source.split("\n");
		// Find the verdict dispatch in the call site
		const verdictAwait = lines.findIndex((l) => l.includes("verdict = await verifyAhead("));
		assert.notEqual(verdictAwait, -1, "call site must await verifyAhead");

		// Check for the three dispatch branches
		const notAheadBranch = lines.findIndex((l) => l.includes('verdict.state === "not-ahead"'));
		const failClosedBranch = lines.findIndex((l) => l.includes('verdict.state === "fail-closed"'));
		const aheadComment = lines.findIndex((l) => l.includes('verdict.state === "ahead"'));

		assert.notEqual(notAheadBranch, -1, "call site must dispatch on 'not-ahead' verdict");
		assert.notEqual(failClosedBranch, -1, "call site must dispatch on 'fail-closed' verdict");
		assert.notEqual(aheadComment, -1, "call site must have comment for 'ahead' verdict");

		// Verify ahead is handled as a comment (meaning proceed without return)
		assert.ok(
			lines.some((l) => l.includes("verdict.state === \"ahead\" — proceed")),
			"call site must handle 'ahead' as proceed (no early return)",
		);
	});

	it("verifyAhead signature includes pi, port, config, headBranch, worktreePath, log — does NOT accept ctx", () => {
		// Find the function signature
		const fnStart = source.indexOf("async function verifyAhead(");
		assert.notEqual(fnStart, -1, "must find verifyAhead function");
		const fnDecl = source.slice(fnStart, fnStart + 300); // Read enough to cover params

		assert.ok(
			fnDecl.includes("pi: ExtensionAPI"),
			"verifyAhead must accept pi: ExtensionAPI",
		);
		assert.ok(
			fnDecl.includes("port: GitHubPort"),
			"verifyAhead must accept port: GitHubPort",
		);
		assert.ok(
			fnDecl.includes("config: SupervisorConfig"),
			"verifyAhead must accept config: SupervisorConfig",
		);
		assert.ok(
			fnDecl.includes("headBranch: string"),
			"verifyAhead must accept headBranch: string",
		);
		assert.ok(
			fnDecl.includes("worktreePath: string"),
			"verifyAhead must accept worktreePath: string",
		);
		assert.ok(
			fnDecl.includes("log: ReturnType<typeof getDebugLogger>"),
			"verifyAhead must accept log: ReturnType<typeof getDebugLogger>",
		);
		// Verify ctx is NOT in the parameter list
		const closeParen = fnDecl.indexOf("): Promise<AheadVerdict>");
		const paramSection = fnDecl.slice(0, closeParen);
		assert.ok(
			!paramSection.includes("ctx"),
			"verifyAhead must NOT accept ctx parameter — UX is caller's responsibility",
		);
	});
});
