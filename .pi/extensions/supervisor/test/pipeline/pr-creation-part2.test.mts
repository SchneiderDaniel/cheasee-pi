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
});
