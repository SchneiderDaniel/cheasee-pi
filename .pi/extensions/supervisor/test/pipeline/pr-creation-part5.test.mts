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
			assert.equal(
				result.pushSkipped,
				undefined,
				"pushSkipped should be undefined when push proceeds",
			);

			const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
			assert.equal(gitPushCalls.length, 1, "push should be called once");
			assert.equal(
				gitPushCalls[0].args[1],
				"--force-with-lease",
				"push should use --force-with-lease",
			);

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
					{ code: 0, stdout: "", stderr: "" }, // git fetch origin <branch>
					{ code: 0, stdout: "", stderr: "" }, // git merge-base --is-ancestor exits 0
					// Phase 2.5: rebase
					{ code: 0, stdout: "fetch ok", stderr: "" }, // git fetch origin main
					{ code: 0, stdout: "rebase ok", stderr: "" }, // git rebase --autostash
					// Phase 3: push
					{ code: 0, stdout: "push ok", stderr: "" }, // git push --force-with-lease
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => {
					throw new Error("API rate limit");
				},
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
			assert.equal(
				result.pushSkipped,
				undefined,
				"pushSkipped should be undefined when push proceeds",
			);

			// Verify exec call order: fetch (phase 2) → merge-base → fetch (phase 2.5) → rebase → push
			assert.equal(
				execCalls.length,
				5,
				"should have 5 exec calls (fetch, merge-base, fetch, rebase, push)",
			);
			assert.ok(execCalls[0].args.includes("fetch"), "first should be git fetch (phase 2)");
			assert.ok(execCalls[1].args.includes("merge-base"), "second should be git merge-base");
			assert.ok(execCalls[2].args.includes("fetch"), "third should be git fetch (phase 2.5)");
			assert.ok(execCalls[3].args.includes("rebase"), "fourth should be git rebase");
			assert.ok(execCalls[4].args.includes("push"), "fifth should be git push");
			assert.equal(
				execCalls[4].args[1],
				"--force-with-lease",
				"push should use --force-with-lease",
			);
		});

		it("compareBranches throws → local fallback: merge-base says NOT ahead → push skipped", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "", stderr: "" }, // git fetch succeeds
					{ code: 1, stdout: "", stderr: "" }, // git merge-base exits 1 (NOT ancestor)
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => {
					throw new Error("API rate limit");
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
					{ code: 1, stdout: "", stderr: "fetch failed" }, // git fetch fails
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockGitHubPort({
				compareBranches: async () => {
					throw new Error("API rate limit");
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

			const infoNotifies = notifyCalls.filter(
				(n) => n.level === "info" && n.message.includes("PR #"),
			);
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
});
