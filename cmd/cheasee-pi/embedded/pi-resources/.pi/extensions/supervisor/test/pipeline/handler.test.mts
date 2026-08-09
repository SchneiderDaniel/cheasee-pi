// ─── Tests: pipeline/handler.ts — handlePostPipeline ordering ───
// Tests the extracted post-loop function to verify merge runs before cleanup.
// Mocks pi.exec and ctx.ui.confirm to simulate all code paths.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PipelineAgentResult, PrCreationResult, PrConflictInfo } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import { handlePostPipeline } from "../../pipeline/handler.ts";
import {
	writeCheckpointFile,
	deleteCheckpointFile,
	readCheckpointFileFromPath,
} from "../../pipeline/state-checkpoint.ts";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Call tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(confirmResult: boolean = true): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: mock.fn(),
			confirm: async () => confirmResult,
		},
	} as unknown as ExtensionCommandContext;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const mockConfig = {
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
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	agentTimeoutsMin: {},
};

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

// ─── Port Helpers ──────────────────────────────────────────────────

function makeConflictInfo(hasConflict: boolean): PrConflictInfo {
	return {
		number: 123,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

function createMockMergePort(hasConflict: boolean = true): GitHubPort {
	return createMockGitHubPort({
		listPullRequestsForBranch: async () => makeConflictInfo(hasConflict),
	});
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handlePostPipeline() — merge/cleanup ordering (Phase 1)", () => {
	it("calls handlePostPipelineMerge before cleanupWorktree (call order: merge, cleanup)", async () => {
		const calls: ExecCall[] = [];
		// PR conflict check is now via port — git fetch/merge/push are still exec calls
		const pi = createMockPi(
			[
				// 1. tryAutoMerge: git fetch origin main
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 2. tryAutoMerge: git merge origin/main --no-edit
				{ code: 0, stdout: "merge ok", stderr: "" },
				// 3. git push
				{ code: 0, stdout: "push ok", stderr: "" },
				// 4. cleanupWorktree: git worktree remove --force
				{ code: 0, stdout: "", stderr: "" },
				// 5. cleanupWorktree: git worktree prune
				{ code: 0, stdout: "", stderr: "" },
				// 6. cleanupWorktree: git branch -D
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Merge calls (git fetch, merge, push) come before cleanup calls
		const mergeCalls = calls.filter(
			(c) =>
				c.cmd === "git" &&
				(c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);

		assert.ok(mergeCalls.length > 0, "should have merge-related exec calls");
		assert.ok(cleanupCalls.length > 0, "should have cleanup exec calls");

		// All merge calls must come before any cleanup call
		const lastMergeIdx = calls.lastIndexOf(mergeCalls[mergeCalls.length - 1]);
		const firstCleanupIdx = calls.indexOf(cleanupCalls[0]);
		assert.ok(
			lastMergeIdx < firstCleanupIdx,
			`merge calls (indices 0..${lastMergeIdx}) must precede cleanup calls (index ${firstCleanupIdx})`,
		);
	});

	it("calls both merge and cleanup when merge succeeds", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
				{ code: 0, stdout: "push ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Both merge and cleanup calls present
		const hasMerge = calls.some(
			(c) => c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		const hasCleanup = calls.some((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(hasMerge, "merge calls should be present");
		assert.ok(hasCleanup, "cleanup calls should be present");
	});

	it("still calls cleanupWorktree when handlePostPipelineMerge succeeds (no-conflict path)", async () => {
		const calls: ExecCall[] = [];
		// No-conflict path: port.listPullRequestsForBranch returns non-conflicting PR, no tryAutoMerge
		const pi = createMockPi(
			[
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// cleanup should still run even though no auto-merge was needed
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when no merge needed");
	});

	it("skips merge when isDoneStatus is false, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Architecture", // not Done
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// No merge calls when not Done
		const gitFetchMergeCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		assert.equal(gitFetchMergeCalls.length, 0, "no merge calls when not Done");

		// Cleanup should still run
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when merge skipped");
	});

	it("skips merge when agentResults is empty, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[], // empty agentResults
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// No merge calls when agentResults empty
		const gitFetchMergeCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		assert.equal(gitFetchMergeCalls.length, 0, "no merge calls when agentResults empty");

		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run");
	});

	it("skips cleanup when worktreePath is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		const port = createMockMergePort(false);
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Merge runs (port.listPullRequestsForBranch called) — no exec calls since merge skips auto-merge
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreePath undefined");
	});

	it("skips cleanup when worktreeBranch is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		const port = createMockMergePort(false);
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			undefined, // no worktreeBranch
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreeBranch undefined");
	});

	it("runs cleanup even when merge check fails (network error from port)", async () => {
		const calls: ExecCall[] = [];
		// port.listPullRequestsForBranch throws → handlePostPipelineMerge catches it
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => { throw new Error("network error"); },
		});
		const pi = createMockPi(
			[
				// cleanup still runs
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Cleanup should still run even though merge check failed
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run even when merge check fails");
	});

	it("passes worktreePath through to git fetch cwd in tryAutoMerge", async () => {
		const calls: ExecCall[] = [];
		const port = createMockMergePort(true);
		const pi = createMockPi(
			[
				// tryAutoMerge: git fetch
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// tryAutoMerge: git merge
				{ code: 0, stdout: "merge ok", stderr: "" },
				// tryAutoMerge: git push
				{ code: 0, stdout: "push ok", stderr: "" },
				// cleanup: git worktree remove
				{ code: 0, stdout: "", stderr: "" },
				// cleanup: git worktree prune
				{ code: 0, stdout: "", stderr: "" },
				// cleanup: git branch -D
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const expectedCwd = "/custom/worktree/path/worktree-git-issue-42-test";

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			expectedCwd,
			"worktree-git-issue-42-test",
			undefined,
			undefined,
			undefined,
			undefined,
			port,
		);

		// Find git fetch call from tryAutoMerge
		const fetchCalls = calls.filter(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCalls.length > 0, "should have git fetch calls");
		assert.equal(
			fetchCalls[0].opts.cwd,
			expectedCwd,
			"git fetch cwd should equal the worktreePath passed to handlePostPipeline",
		);

		// Find git merge call from tryAutoMerge
		const mergeCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "merge");
		assert.ok(mergeCalls.length > 0, "should have git merge calls");
		assert.equal(
			mergeCalls[0].opts.cwd,
			expectedCwd,
			"git merge cwd should equal the worktreePath passed to handlePostPipeline",
		);
	});

	it("skips both merge and cleanup when worktreePath is undefined and agentResults empty", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[], // empty agentResults → skip merge
			mockConfig as any,
			pi,
			ctx,
			undefined, // no worktreePath → skip cleanup too
			"worktree-git-issue-42-test",
		);

		// No merge calls
		const gitFetchMergeCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push"),
		);
		assert.equal(gitFetchMergeCalls.length, 0, "no merge attempted when agentResults empty");

		// No cleanup either since worktreePath is undefined
		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 0, "no cleanup when worktreePath is undefined");
	});

	// ─── Phase 5: Conditional Worktree Cleanup ───────────────────────

	it("PR fails + isDebug=true → worktree preserved (cleanup skipped)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(true);
		const failedPr: PrCreationResult = { success: false, error: "Push failed" };
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			failedPr,
			true, // isDebug = true → preserve worktree
			undefined,
			undefined,
			port,
		);

		// Cleanup should NOT be called
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.equal(cleanupCalls.length, 0, "no cleanup when PR fails in debug mode");
	});

	it("PR fails + isDebug=false → worktree cleaned up normally", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanup
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const failedPr: PrCreationResult = { success: false, error: "Push failed" };
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			failedPr,
			false, // isDebug = false → normal cleanup
			undefined,
			undefined,
			port,
		);

		// Cleanup SHOULD be called
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run when not in debug mode");
	});

	it("PR succeeds + isDebug=true → worktree cleaned up normally", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanup
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const successPr: PrCreationResult = { success: true, prNumber: 456 };
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			successPr,
			true, // isDebug = true but PR succeeded → normal cleanup
			undefined,
			undefined,
			port,
		);

		// Cleanup SHOULD be called (PR succeeded, debug doesn't preserve)
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run when PR succeeds even in debug mode");
	});

	it("PR result undefined + isDebug=true → worktree cleaned up normally", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanup
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const port = createMockMergePort(false);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
			undefined, // no prCreationResult
			true, // isDebug = true but no PR failure → normal cleanup
			undefined,
			undefined,
			port,
		);

		// Cleanup SHOULD be called (no PR failure)
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run when no PR failure even in debug mode");
	});

	// ─── Phase 4: deleteCheckpointFile integration ─────────────────────

	describe("handlePostPipeline — deleteCheckpointFile integration (Phase 4)", () => {
		it("calls deleteCheckpointFile in finally block (state file deleted after run)", async () => {
			// Create a temp dir with a state file
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-delete-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			// Write a state file before calling handlePostPipeline
			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-auditor",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const statePath = join(tmpDir, ".pi", "supervisor-state.json");
			assert.equal(existsSync(statePath), true);

			// Create ctx with tmpDir as cwd
			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			// Run handlePostPipeline — merge skipped (non-Done status), cleanup runs
			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git worktree remove
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git worktree prune
					{ code: 0, stdout: "", stderr: "" }, // cleanup: git branch -D
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Architecture", // not Done → merge skipped
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
			);

			// State file should be deleted after handlePostPipeline runs
			assert.equal(
				existsSync(statePath),
				false,
				"state file should be deleted after handlePostPipeline",
			);

			// Cleanup temp dir
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("deleteCheckpointFile runs even when handlePostPipelineMerge throws", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-merge-throws-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			// Write a state file before calling handlePostPipeline
			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-auditor",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const statePath = join(tmpDir, ".pi", "supervisor-state.json");
			assert.equal(existsSync(statePath), true);

			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			// handlePostPipelineMerge will fail (port.listPullRequestsForBranch throws)
			const port = createMockGitHubPort({
				listPullRequestsForBranch: async () => { throw new Error("network error"); },
			});
			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					// cleanup still runs
					{ code: 0, stdout: "", stderr: "" },
					{ code: 0, stdout: "", stderr: "" },
					{ code: 0, stdout: "", stderr: "" },
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Done",
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				undefined,
				port,
			);

			// State file should still be deleted (finally block runs)
			assert.equal(
				existsSync(statePath),
				false,
				"state file should be deleted even when merge throws",
			);

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("deleteCheckpointFile called in finally after cleanup completes", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "handler-test-order-"));
			mkdirSync(join(tmpDir, ".pi"), { recursive: true });

			const stateResult = writeCheckpointFile(tmpDir, {
				issueNum: 42,
				checkpoint: "pre-tsc",
				worktreePath: "/repo/../worktrees/worktree-git-issue-42-test",
				worktreeBranch: "worktree-git-issue-42-test",
				startedAt: new Date().toISOString(),
			});
			assert.equal(stateResult.ok, true);

			const ctx = createMockCtx(true);
			const ctxWithCwd = {
				...ctx,
				cwd: tmpDir,
			} as unknown as ExtensionCommandContext;

			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					// cleanup: git worktree remove
					{ code: 0, stdout: "", stderr: "" },
					// cleanup: git worktree prune
					{ code: 0, stdout: "", stderr: "" },
					// cleanup: git branch -D
					{ code: 0, stdout: "", stderr: "" },
				],
				calls,
			);

			await handlePostPipeline(
				42,
				"Test issue",
				"Architecture",
				[mockAgentResult],
				mockConfig as any,
				pi,
				ctxWithCwd,
				"/repo/../worktrees/worktree-git-issue-42-test",
				"worktree-git-issue-42-test",
			);

			// The state file should be deleted — verify by reading
			const readResult = readCheckpointFileFromPath(join(tmpDir, ".pi", "supervisor-state.json"));
			assert.equal(readResult, null, "state file should be deleted");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3 (issue #1472): runAgentLoop pre-Done PR-readiness gate wiring
// Harness runs the real runAgentLoop with an injected mock agent runner
// (RunContext._runner) so no subprocess is spawned. createPrOnApproval,
// ensurePrReadyForDone and the status transitions run for real against
// mocked port/pi/exec.
// ═══════════════════════════════════════════════════════════════════

import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import type { AgentRunResult, ProjectField, ProjectItem } from "../../config/types.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import type { PortCall } from "../helper/mock-github-port.ts";

// Auditor APPROVED structured output — parses to nextStatus "Done".
const AUDITOR_APPROVED_OUTPUT = [
	"## Audit Complete",
	"",
	"```json",
	JSON.stringify({
		action: "APPROVED",
		agentName: "auditor",
		summary: "Audit approved",
		commentBody: "## Audit Approved\n\nAll dimensions verified.",
		auditScore: { passing: 6, total: 6 },
	}),
	"```",
].join("\n");

// Auditor result but approved (used for the gate-failure path too —
// the developer dispatch inside the gate uses the same runner).
function makeHarnessRunnerResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "auditor",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: AUDITOR_APPROVED_OUTPUT,
		textOnly: AUDITOR_APPROVED_OUTPUT,
		summaryLine: "Audit approved",
		errorOutput: "",
		...overrides,
	};
}

// Shared runner: auditor call → APPROVED; developer call (gate conflict
// resolution) → devSuccess.
function createHarnessRunner(devSuccess: boolean) {
	return mock.fn(
		async (...args: any[]) => {
			const agent = args[0] as { config: { name: string } };
			if (agent?.config?.name === "developer") {
				return makeHarnessRunnerResult({
					agentName: "developer",
					success: devSuccess,
					summaryLine: devSuccess ? "Resolved merge conflicts" : "Could not resolve conflicts",
					textOutput: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
					textOnly: devSuccess ? "Resolved\nCONFLICTS_RESOLVED" : "Failed to resolve",
				});
			}
			return makeHarnessRunnerResult({});
		},
	);
}

const GATE_FIELDS: ProjectField[] = [
	{
		id: "status-field-id",
		name: "Status",
		type: "single_select",
		options: [
			{ id: "opt-backlog", name: "Backlog" },
			{ id: "opt-research", name: "Research" },
			{ id: "opt-architecture", name: "Architecture" },
			{ id: "opt-test-design", name: "TestDesign" },
			{ id: "opt-implementation", name: "Implementation" },
			{ id: "opt-audit", name: "Audit" },
			{ id: "opt-done", name: "Done" },
		],
	},
];

const GATE_STATUS_FIELD = GATE_FIELDS[0]!;
const GATE_LOOP_ITEM: ProjectItem = { id: "item-1" };

function makeGateCleanInfo(): PrConflictInfo {
	return {
		number: 456,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

// Builds the full RunContext for the Audit → PR-creation → gate flow.
// portPrLifecycle: listPullRequestsForBranch returns null until
// createPullRequest is called, then a clean PR.
function buildGateRunContext(opts: {
	execResults: Array<{ code: number; stdout: string; stderr: string }>;
	runner: ReturnType<typeof mock.fn>;
	portCalls: PortCall[];
	tmpCwd: string;
	wt: string;
}): RunContext {
	const execCalls: ExecCall[] = [];
	const pi = createMockPi(opts.execResults, execCalls);
	const ctx = createMockCtx(true);
	const ctxWithCwd = { ...ctx, cwd: opts.tmpCwd } as unknown as ExtensionCommandContext;

	let prCreated = false;
	const port = createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => (prCreated ? makeGateCleanInfo() : null),
			createPullRequest: async () => {
				prCreated = true;
				return { number: 456 };
			},
			updatePullRequest: async () => {},
			postIssueComment: async () => {},
			getClosingPrsForIssue: async () => [],
		},
		opts.portCalls,
	);

	return {
		args: undefined,
		ctx: ctxWithCwd,
		pi,
		issueNum: 42,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 42,
						title: "Test issue",
						body: "body",
						author: { login: "user1" },
						comments: [],
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: mockConfig as any,
		port,
		issueTitle: "Test issue",
		filteredData: { body: "body", comments: [] },
		issueData: { number: 42, title: "Test issue", body: "body", author: { login: "user1" }, comments: [] },
		stageState: createStageState("Audit"),
		loopStatus: "Audit",
		loopItem: GATE_LOOP_ITEM,
		fields: GATE_FIELDS,
		statusField: GATE_STATUS_FIELD,
		projectId: "project-1",
		worktreePath: opts.wt,
		worktreeBranch: "worktree-git-issue-42-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

function makeGateWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "handler-gate-wt-"));
	const agentDir = join(dir, ".pi/extensions/supervisor/agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "developer.md"), "---\nname: developer\n---\n\nTest dev.", "utf-8");
	return dir;
}

describe("runAgentLoop — pre-Done PR readiness gate (issue #1472)", () => {
	it("auditor success + createPrOnApproval success + gate ok → Done applied (normal completion unchanged)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(true);

		const runCtx = buildGateRunContext({
			execResults: [
				{ code: 0, stdout: "fetch ok", stderr: "" }, // rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // push
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(transitions.includes("opt-done"), "Done transition applied");
		assert.ok(!transitions.includes("opt-implementation"), "no Implementation transition");
		assert.equal(runCtx.loopStatus, "Done");
		assert.equal(runCtx.stopReason, undefined, "no stop reason on the normal path");
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			1,
			"PR created once",
		);
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("auditor success + rebaseConflicts + developer resolves + retry ok → Done applied (recovery path)", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(true);

		const runCtx = buildGateRunContext({
			execResults: [
				// createPrOnApproval rebase fails with conflicts
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 1 rebase fetch
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // 2 rebase fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 3 diff
				{ code: 0, stdout: "", stderr: "" }, // 4 rebase --abort
				{ code: 1, stdout: "", stderr: "merge failed" }, // 5 merge fallback fails
				{ code: 0, stdout: "", stderr: "" }, // 6 merge --abort
				// gate: resolveBranchConflicts → tryAutoMerge fails → dev dispatch
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 7 merge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // 8 merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 9 diff
				{ code: 0, stdout: "", stderr: "" }, // 10 merge --abort
				// gate: bounded retry of createPrOnApproval succeeds
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 11 retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // 12 retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // 13 retry push
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(transitions.includes("opt-done"), "Done applied after conflict resolution");
		assert.ok(!transitions.includes("opt-implementation"), "no Implementation transition");
		assert.equal(runCtx.loopStatus, "Done");
		assert.equal(
			portCalls.filter((c) => c.method === "createPullRequest").length,
			1,
			"createPrOnApproval retried exactly once after resolution",
		);
		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.config?.name === "developer",
		);
		assert.equal(devCalls.length, 1, "exactly one developer dispatch for conflict resolution");
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("gate { ok: false } → no Done transition; issue moved to Implementation; blocker comment posted; loop breaks with stopReason", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "handler-gate-cwd-"));
		const wt = makeGateWorktree();
		const portCalls: PortCall[] = [];
		const runner = createHarnessRunner(false); // developer fails to resolve

		const runCtx = buildGateRunContext({
			execResults: [
				// createPrOnApproval rebase fails with conflicts
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 1
				{ code: 1, stdout: "", stderr: "rebase conflict" }, // 2
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 3
				{ code: 0, stdout: "", stderr: "" }, // 4
				{ code: 1, stdout: "", stderr: "merge failed" }, // 5
				{ code: 0, stdout: "", stderr: "" }, // 6
				// gate: resolveBranchConflicts → tryAutoMerge fails → dev dispatch FAILS
				{ code: 0, stdout: "fetch ok", stderr: "" }, // 7
				{ code: 1, stdout: "", stderr: "merge failed" }, // 8
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // 9
				{ code: 0, stdout: "", stderr: "" }, // 10
			],
			runner,
			portCalls,
			tmpCwd,
			wt,
		});

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(
			!transitions.includes("opt-done"),
			"Done transition must NOT be applied when the gate blocks",
		);
		assert.ok(
			transitions.includes("opt-implementation"),
			"issue transitions to Implementation (non-Done)",
		);
		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.ok(
			comments.some((b) => b.includes("PR Readiness Blocked")),
			"blocker comment posted",
		);
		assert.ok(
			comments.some((b) => b.includes("Manual Intervention Required")),
			"blocker comment demands manual intervention",
		);
		assert.ok(runCtx.stopReason?.includes("PR readiness"), "stopReason set from gate verdict");
		assert.equal(runCtx.loopStatus, "Implementation", "loop leaves issue in non-Done status");
		assert.ok(
			runCtx.prCreationResult && !runCtx.prCreationResult.success,
			"failed prCreationResult propagated for post-pipeline phase",
		);
		assert.deepEqual(
			runCtx.prCreationResult!.rebaseConflicts,
			["src/a.ts"],
			"rebase conflicts propagated",
		);
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});
});
