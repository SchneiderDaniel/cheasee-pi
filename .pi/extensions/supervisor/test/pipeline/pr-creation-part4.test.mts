import { describe, it, mock } from "node:test";

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
		const pruneCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "--prune",
		);
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
			listPullRequestsForBranch: async () => {
				throw new Error("network error");
			},
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
});
