// ─── Tests: pipeline/pr-creation.ts — createPrOnApproval ──────────
// Unit tests for the PR creation flow. Mocks pi.exec (for git push only)
// and ctx.ui. Port methods are mocked via createMockGitHubPort.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubPort, type PortCall } from "../../test/helper/mock-github-port.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";
import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

// ─── Call Tracking ────────────────────────────────────────────────

interface NotifyCall {
	message: string;
	level: string;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI that only handles git push calls.
 * All GitHub API operations go through the port mock instead.
 */
function createMockPi(calls?: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>): ExtensionAPI {
	const callLog = calls || [];
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			// git push --force succeeds by default
			if (cmd === "git" && args[0] === "push") {
				return Promise.resolve({ code: 0, stdout: "Everything up-to-date", stderr: "" });
			}
			return Promise.resolve({ code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

/**
 * Create a mock pi.exec that fails for specific patterns.
 * Used for testing push failure scenarios.
 */
function createFailingMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++] || { code: 0, stdout: "", stderr: "" };
			if (result.code !== 0) {
				return Promise.reject(new Error(result.stderr || result.stdout || `Command failed: ${cmd}`));
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
};

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

/** Existing PR conflict info fixture. */
function existingPrInfo(prNumber: number = 123): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("createPrOnApproval()", () => {
	it("Happy path with worktree: push → compare check → list PR → create PR → success notifications", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		// 1. git push
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[0].args[0], "push");
		assert.equal(execCalls[0].args[1], "--force");
		assert.equal(execCalls[0].args[2], "origin");
		assert.equal(execCalls[0].args[3], "worktree-git-issue-42-test");
		assert.equal(execCalls[0].opts.cwd, "/worktrees/wt-42");
		assert.equal(execCalls[0].opts.timeout, 60000);

		// 2. port.compareBranches
		assert.equal(portCalls[0].method, "compareBranches");
		assert.equal(portCalls[0].args[0], "main");
		assert.equal(portCalls[0].args[1], "worktree-git-issue-42-test");
		assert.equal(portCalls[0].args[2], "owner/repo");

		// 3. port.listPullRequestsForBranch
		assert.equal(portCalls[1].method, "listPullRequestsForBranch");
		assert.equal(portCalls[1].args[0], "worktree-git-issue-42-test");

		// 4. port.createPullRequest
		assert.equal(portCalls[2].method, "createPullRequest");
		const createInput = portCalls[2].args[0] as Record<string, unknown>;
		assert.equal(createInput.base, "main");
		assert.equal(createInput.head, "worktree-git-issue-42-test");

		// Verify success notification
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.ok(infoNotifies.some((n) => n.message.includes("PR #456 created")), "should have PR creation notification");
	});

	it("Happy path without worktree: skip git push → check PR → create PR → success", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], undefined, "worktree-git-issue-42-test");

		// Verify no git push call
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 0, "no git push when worktreePath is undefined");

		// Port calls: listPullRequestsForBranch, createPullRequest
		assert.equal(portCalls.length, 2, "should have 2 port calls");
		assert.equal(portCalls[0].method, "listPullRequestsForBranch");
		assert.equal(portCalls[1].method, "createPullRequest");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.ok(infoNotifies.some((n) => n.message.includes("PR #456 created")), "should have PR creation notification");
	});

	it("Existing PR found: push → check PR → update via port.updatePullRequest", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => existingPrInfo(123),
				updatePullRequest: async () => {},
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		// port call order: compareBranches, listPullRequestsForBranch, updatePullRequest
		assert.equal(portCalls[0].method, "compareBranches");
		assert.equal(portCalls[1].method, "listPullRequestsForBranch");
		assert.equal(portCalls[2].method, "updatePullRequest");
		assert.equal(portCalls[2].args[0], 123, "should update existing PR #123");

		// No createPullRequest call
		const createCalls = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 0, "no createPullRequest when PR already exists");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.ok(infoNotifies.some((n) => n.message.includes("PR #123 updated")), "should have PR update notification");
	});

	it("Push failure: returns PrCreationResult with success=false and no PR attempt", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// All 3 push retries fail
		const pi = createFailingMockPi(
			[
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				{ code: 1, stdout: "", stderr: "push failed: timeout" },
			],
			execCalls,
		);
		const port = createMockGitHubPort({}, portCalls);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const pushError = errorNotifies.find((n) => n.message.toLowerCase().includes("push failed"));
		assert.ok(pushError, "should have error notification for push failure");

		// No port calls after push failure
		assert.equal(portCalls.length, 0, "should not attempt port operations after push failure");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.includes("push"), "error should mention push failure");
	});

	it("port.createPullRequest failure: error notification delivered, function does not throw unhandled", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => { throw new Error("create failed: GraphQL error"); },
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await assert.doesNotReject(
			createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test"),
		);

		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		assert.ok(errorNotifies.some((n) => n.message.toLowerCase().includes("failed")), "should have error notification for PR creation failure");
	});

	it("port.listPullRequestsForBranch failure: caught, warning notification, PR creation still attempted", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => { throw new Error("network error"); },
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
		assert.ok(warningNotifies.some((n) => n.message.toLowerCase().includes("pr conflict check failed")), "should have warning notification for PR conflict check failure");

		// PR creation was still attempted via port
		assert.ok(portCalls.some((c) => c.method === "createPullRequest"), "should still attempt PR creation");
	});

	it("Regression: does NOT call git rev-list --count anywhere", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		const revListCalls = execCalls.filter((c) => c.cmd === "git" && c.args.some((a) => a === "rev-list" || a.includes("rev-list")));
		assert.equal(revListCalls.length, 0, "should NOT call git rev-list --count");
	});

	it("agentResults empty array: still writes PR body file and creates PR", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [], undefined, "worktree-git-issue-42-test");

		assert.equal(portCalls.length, 2, "should have 2 port calls");
		assert.equal(portCalls[0].method, "listPullRequestsForBranch");
		assert.equal(portCalls[1].method, "createPullRequest");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.ok(infoNotifies.some((n) => n.message.includes("PR #456 created")), "should have PR creation notification");
	});

	it("Boundary: worktreeBranch undefined, no worktreePath: branch generated from issueNum and title", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], undefined, undefined);

		// listPullRequestsForBranch should receive an auto-generated branch name
		assert.equal(portCalls[0].method, "listPullRequestsForBranch");
		const branchName = portCalls[0].args[0] as string;
		assert.ok(branchName.startsWith("worktree-git-issue-42-"), `branch name should be generated from issue number: ${branchName}`);

		// PR create should use same generated branch name
		assert.equal(portCalls[1].method, "createPullRequest");
		const createInput = portCalls[1].args[0] as Record<string, unknown>;
		assert.equal(createInput.head, branchName, "pr create should use same generated branch name");
	});

	// ─── PrCreationResult Tests ────────────────────────────────────────

	it("returns PrCreationResult with success=true when PR is created", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 456, "should contain PR number");
		assert.equal(result.error, undefined, "should have no error");
	});

	it("returns PrCreationResult with success=true and wasUpdate=true when PR is updated", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => existingPrInfo(123),
				updatePullRequest: async () => {},
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 123, "should contain existing PR number");
		assert.equal(result.wasUpdate, true, "should be marked as update");
	});

	it("returns PrCreationResult with success=false when createPullRequest fails (both retries)", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => { throw new Error("create failed: GraphQL error"); },
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.length > 0, "error should not be empty");
	});

	it("returns PrCreationResult with success=false when push fails", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createFailingMockPi(
			[
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				{ code: 1, stdout: "", stderr: "push failed: timeout" },
			],
			execCalls,
		);
		const port = createMockGitHubPort({}, portCalls);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when push fails");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.toLowerCase().includes("push"), "error should mention push failure");

		// No port calls after push failure
		assert.equal(portCalls.length, 0, "should not attempt PR creation after push failure");
	});

	it("push retry: first push fails, retry succeeds after backoff", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createFailingMockPi(
			[
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
			],
			execCalls,
		);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after push retry");

		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 2, "should retry push once after failure");

		for (const pushCall of gitPushCalls) {
			assert.equal(pushCall.opts.timeout, 60000, "push timeout should be 60000");
		}
	});

	it("push retry: all 3 attempts exhausted → failure", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createFailingMockPi(
			[
				{ code: 1, stdout: "", stderr: "push failed: error 1" },
				{ code: 1, stdout: "", stderr: "push failed: error 2" },
				{ code: 1, stdout: "", stderr: "push failed: error 3" },
			],
			execCalls,
		);
		const port = createMockGitHubPort({}, portCalls);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after all push retries exhausted");
		assert.ok(result.error, "should contain error message");

		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 3, "should make 3 push attempts");

		assert.equal(portCalls.length, 0, "should not attempt PR after push failure");
	});

	it("returns PrCreationResult with success=true when PR conflict check throws (graceful degradation)", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => { throw new Error("network error"); },
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should still succeed if PR creation works despite check failure");
		assert.equal(result.prNumber, 456, "should contain PR number");
	});

	it("retries createPullRequest with backoff on transient failure", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		let createAttempt = 0;
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => {
					createAttempt++;
					if (createAttempt === 1) throw new Error("rate limit exceeded");
					return { number: 789 };
				},
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after retry");
		assert.equal(result.prNumber, 789, "should contain PR number from retry");

		// Two createPullRequest calls made
		const createCalls = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 2, "should retry createPullRequest once");
	});

	it("fails after retry exhausted", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 3,
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => { throw new Error("rate limit exceeded"); },
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after retry exhaustion");
		assert.ok(result.error, "should contain error message");

		const createCalls = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 2, "should make exactly 2 attempts");
	});

	// ─── Bug 2: ahead_by=0 ─────────────────────────────────────────

	it("Bug 2: ahead_by=0 returns success=false with 'No commits ahead' error", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 0, // ahead_by = 0
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

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

		// Only compareBranches called, no listPullRequestsForBranch or createPullRequest
		assert.equal(portCalls.length, 1, "should have exactly 1 port call (compareBranches)");
		assert.equal(portCalls[0].method, "compareBranches");
	});

	it("Bug 2: ahead_by=0 does NOT report 'created' in output (no misleading PR #undefined)", async () => {
		const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const portCalls: PortCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(execCalls);
		const port = createMockGitHubPort(
			{
				compareBranches: async () => 0, // ahead_by = 0
			},
			portCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(port, pi, ctx, 42, "Test issue", mockConfig as any, [mockAgentResult], "/worktrees/wt-42", "worktree-git-issue-42-test");

		// No createPullRequest or updatePullRequest calls
		const createOrUpdate = portCalls.filter((c) => c.method === "createPullRequest" || c.method === "updatePullRequest");
		assert.equal(createOrUpdate.length, 0, "no PR create or update should be attempted");

		// Only compareBranches was called
		assert.equal(portCalls.length, 1, "exactly 1 port call");
		assert.equal(portCalls[0].method, "compareBranches", "should call compareBranches");

		assert.equal(result.success, false, "should not indicate success");
		assert.equal(result.prNumber, undefined, "prNumber should be undefined");
	});
});
