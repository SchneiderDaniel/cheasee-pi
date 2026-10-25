import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import type { PortCall } from "../helper/mock-github-port.ts";

import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

interface NotifyCall {
	message: string;
	level: string;
}

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

function flushQueue(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

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
			listPullRequestsForBranch: async () => {
				throw new Error("network error");
			},
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
});
