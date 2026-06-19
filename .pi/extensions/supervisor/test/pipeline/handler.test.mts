// ─── Tests: pipeline/handler.ts — handlePostPipeline ordering ───
// Tests the extracted post-loop function to verify merge runs before cleanup.
// Mocks pi.exec and ctx.ui.confirm to simulate all code paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PipelineAgentResult, PrCreationResult } from "../../config/types.ts";
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

// Each exec call returns a JSON array for gh `pr list` by default (used by checkPrConflicts).
// Function resultBuilder builds the response array incrementally.
function prListResult(hasConflict: boolean): string {
	return JSON.stringify([
		{
			number: 123,
			mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
			mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
			headRefName: "worktree-git-issue-42-test",
			baseRefName: "main",
		},
	]);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handlePostPipeline() — merge/cleanup ordering (Phase 1)", () => {
	it("calls handlePostPipelineMerge before cleanupWorktree (call order: merge, cleanup)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// 1. checkPrConflicts → gh pr list returns conflict
				{ code: 0, stdout: prListResult(true), stderr: "" },
				// 2. tryAutoMerge: git fetch origin main
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 3. tryAutoMerge: git merge origin/main --no-edit
				{ code: 0, stdout: "merge ok", stderr: "" },
				// 4. git push
				{ code: 0, stdout: "push ok", stderr: "" },
				// 5. cleanupWorktree: git worktree remove --force
				{ code: 0, stdout: "", stderr: "" },
				// 6. cleanupWorktree: git worktree prune
				{ code: 0, stdout: "", stderr: "" },
				// 7. cleanupWorktree: git branch -D
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
		);

		// Verify merge calls come before cleanup calls
		const mergeCalls = calls.filter(
			(c) =>
				c.cmd === "gh" ||
				c.cmd === "bash" ||
				(c.cmd === "git" &&
					(c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push")),
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
				{ code: 0, stdout: prListResult(true), stderr: "" },
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
		);

		// Both merge and cleanup calls present
		const hasMerge = calls.some(
			(c) =>
				c.cmd === "gh" ||
				c.cmd === "bash" ||
				(c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge")),
		);
		const hasCleanup = calls.some((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(hasMerge, "merge calls should be present");
		assert.ok(hasCleanup, "cleanup calls should be present");
	});

	it("still calls cleanupWorktree when handlePostPipelineMerge succeeds (no-conflict path)", async () => {
		const calls: ExecCall[] = [];
		// No-conflict path: gh pr list returns mergeable PR, no tryAutoMerge
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" },
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
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
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

		// No gh calls (no merge attempted)
		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.equal(ghCalls.length, 0, "no merge/gh calls when not Done");

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

		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.equal(ghCalls.length, 0, "no merge/gh calls when agentResults empty");

		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run");
	});

	it("skips cleanup when worktreePath is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		// Merge runs (checkPrConflicts) — needs gh response
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" }, // gh pr list
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
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
		);

		// Merge runs (makes gh call), but cleanup skips
		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCalls.length > 0, "merge/gh calls should still run");
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreePath undefined");
	});

	it("skips cleanup when worktreeBranch is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" }, // gh pr list
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
			undefined, // no worktreeBranch
		);

		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCalls.length > 0, "merge/gh calls should still run");
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreeBranch undefined");
	});

	it("runs cleanup even when merge check fails (network error, checkPrConflicts throws)", async () => {
		const calls: ExecCall[] = [];
		// gh call fails → checkPrConflicts throws → handlePostPipelineMerge catches it
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "network error" }, // gh fails
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
		);

		// Cleanup should still run even though merge check failed
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run even when merge check fails");
	});

	it("passes worktreePath through to git fetch cwd in tryAutoMerge", async () => {
		const calls: ExecCall[] = [];
		// Need extra results for cleanup (3 git calls)
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" }, // gh pr list
				{ code: 0, stdout: "fetch ok", stderr: "" }, // git fetch
				{ code: 0, stdout: "merge ok", stderr: "" }, // git merge
				{ code: 0, stdout: "push ok", stderr: "" }, // git push
				{ code: 0, stdout: "", stderr: "" }, // git worktree remove
				{ code: 0, stdout: "", stderr: "" }, // git worktree prune
				{ code: 0, stdout: "", stderr: "" }, // git branch -D
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

		// No gh calls = no merge
		const ghCalls = calls.filter((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.equal(ghCalls.length, 0, "no merge attempted when agentResults empty");

		// No cleanup either since worktreePath is undefined
		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 0, "no cleanup when worktreePath is undefined");
	});

	// ─── Phase 5: Conditional Worktree Cleanup ───────────────────────

	it("PR fails + isDebug=true → worktree preserved (cleanup skipped)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// handlePostPipelineMerge: checkPrConflicts
				{ code: 0, stdout: prListResult(false), stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const failedPr: PrCreationResult = { success: false, error: "Push failed" };

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
				// handlePostPipelineMerge: checkPrConflicts
				{ code: 0, stdout: prListResult(false), stderr: "" },
				// cleanup
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const failedPr: PrCreationResult = { success: false, error: "Push failed" };

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
				// handlePostPipelineMerge: checkPrConflicts
				{ code: 0, stdout: prListResult(false), stderr: "" },
				// cleanup
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const successPr: PrCreationResult = { success: true, prNumber: 456 };

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
				// handlePostPipelineMerge: checkPrConflicts
				{ code: 0, stdout: prListResult(false), stderr: "" },
				// cleanup
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
			undefined, // no prCreationResult
			true, // isDebug = true but no PR failure → normal cleanup
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

			// handlePostPipelineMerge will fail (gh pr list returns error)
			const calls: ExecCall[] = [];
			const pi = createMockPi(
				[
					// merge fails (gh pr list)
					{ code: 1, stdout: "", stderr: "network error" },
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

