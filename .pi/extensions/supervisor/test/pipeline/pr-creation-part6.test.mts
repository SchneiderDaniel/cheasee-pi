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
			assert.deepEqual(
				result.rebaseConflicts,
				["src/a.ts", "src/b.ts"],
				"should report rebase conflict files",
			);
			assert.equal(result.prNumber, undefined, "no PR number");

			// Verify warning notification with conflict file names
			const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
			const rebaseWarning = warningNotifies.find((n) => n.message.includes("Rebase conflicts"));
			assert.ok(rebaseWarning, "should have warning notification for rebase conflicts");
			assert.ok(
				rebaseWarning!.message.includes("src/a.ts"),
				"warning should mention conflicted files",
			);
			assert.ok(
				rebaseWarning!.message.includes("src/b.ts"),
				"warning should mention all conflicted files",
			);

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

			const infoNotifies = notifyCalls.filter(
				(n) => n.level === "info" && n.message.includes("PR #"),
			);
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
			assert.equal(
				result.rebaseConflicts,
				undefined,
				"rebaseConflicts should not be set when rebase not attempted",
			);

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
	});
});
