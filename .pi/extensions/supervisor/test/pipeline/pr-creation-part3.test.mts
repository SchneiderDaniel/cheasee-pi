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
		const pruneCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "--prune",
		);
		assert.equal(pushCalls.length, 3, "should make exactly 3 push attempts");
		assert.equal(pruneCalls.length, 2, "lease refresh before each retry");

		// Failure contract: {success:false}, stderr excerpt in error + notify
		assert.equal(result!.success, false, "failed push must not report success");
		assert.ok(
			result!.error!.includes("error: failed to push some refs"),
			"error embeds stderr excerpt",
		);
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		assert.ok(
			errorNotifies.some(
				(n) => n.message.includes("push failed") && n.message.includes("failed to push some refs"),
			),
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
		assert.ok(
			errorNotifies.some((n) => n.message.includes("push failed")),
			"error notification delivered",
		);
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
		assert.ok(
			errorNotifies.some((n) => n.message.includes("fatal: unable to access")),
			"notify carries fatal excerpt",
		);
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
});
