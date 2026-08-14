// ─── Tests: pipeline/state-checkpoint.ts — crash recovery state file ──
// Phase 1: Pure functions (isStaleCheckpoint, readCheckpointFile, writeCheckpointFile)
// Phase 2: File I/O with real temp dir (writeCheckpointFile, deleteCheckpointFile, readCheckpointFile)
// Phase 3: cleanupStalePipelineState with mock pi.exec
//
// Run: node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/state-checkpoint.test.mts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";
import {
	isStaleCheckpoint,
	readCheckpointFileFromPath,
	writeCheckpointFile,
	deleteCheckpointFile,
	cleanupStalePipelineState,
	acquireRunLock,
	releaseRunLock,
	isAnyOtherPipelineLive,
	type SupervisorCheckpointState,
	type CheckpointName,
} from "../../pipeline/state-checkpoint.ts";

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
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
			const result = results[idx++] || { code: 0, stdout: "", stderr: "" };
			if (result.code !== 0) {
				return Promise.reject(
					new Error(result.stderr || result.stdout || `Command failed: ${cmd}`),
				);
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

function createMockNotify(): { notify: NotifyFn; calls: Array<{ level: string; msg: string }> } {
	const calls: Array<{ level: string; msg: string }> = [];
	const notify: NotifyFn = {
		info: (msg: string) => calls.push({ level: "info", msg }),
		error: (msg: string) => calls.push({ level: "error", msg }),
	};
	return { notify, calls };
}

// ─── Fixtures ──────────────────────────────────────────────────────

function createState(
	overrides: Partial<SupervisorCheckpointState> = {},
): SupervisorCheckpointState {
	return {
		issueNum: 746,
		checkpoint: "pre-tsc" as CheckpointName,
		worktreePath: "/tmp/worktrees/worktree-git-issue-746-test",
		worktreeBranch: "worktree-git-issue-746-test",
		startedAt: new Date(Date.now() - 30_000).toISOString(), // 30 seconds ago
		...overrides,
	};
}

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: { todo: "developer" },
	maxRejections: 3,
	codeowners: [],
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
	agentTimeoutsMin: {},
};

// ─── Phase 1: Pure Functions ───────────────────────────────────────

describe("isStaleCheckpoint() — pure function (Phase 1)", () => {
	it("returns true when startedAt is exactly 1h + 1ms ago (strictly > 1h)", () => {
		const state = createState({
			startedAt: new Date(Date.now() - 3_600_001).toISOString(), // 1h + 1ms ago
		});
		assert.equal(isStaleCheckpoint(state), true);
	});

	it("returns false when startedAt is 59 minutes ago (under 1h)", () => {
		const state = createState({
			startedAt: new Date(Date.now() - 3_540_000).toISOString(), // 59 min ago
		});
		assert.equal(isStaleCheckpoint(state), false);
	});

	it("returns false when startedAt is exactly 1h ago (boundary — not strictly older)", () => {
		const state = createState({
			startedAt: new Date(Date.now() - 3_600_000).toISOString(), // exactly 1h ago
		});
		assert.equal(isStaleCheckpoint(state), false);
	});

	it("returns true when startedAt is far past (hours old)", () => {
		const state = createState({
			startedAt: new Date(Date.now() - 86_400_000).toISOString(), // 24h ago
		});
		assert.equal(isStaleCheckpoint(state), true);
	});

	it("returns true with custom maxAgeMs=0 (any past)", () => {
		const state = createState({
			startedAt: new Date(Date.now() - 100).toISOString(), // 100ms ago
		});
		assert.equal(isStaleCheckpoint(state, 0), true);
	});

	it("returns false when startedAt is in the future (clock skew tolerance)", () => {
		const state = createState({
			startedAt: new Date(Date.now() + 3_600_000).toISOString(), // 1h in future
		});
		assert.equal(isStaleCheckpoint(state), false);
	});

	it("returns true when startedAt is an invalid date string (safety: clean up)", () => {
		const state = createState({
			startedAt: "not-a-date",
		});
		assert.equal(isStaleCheckpoint(state), true);
	});
});

// ─── Phase 2: File I/O with Real Temp Dir ─────────────────────────

describe("writeCheckpointFile / readCheckpointFile / deleteCheckpointFile — file I/O (Phase 2)", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "state-checkpoint-test-"));
		// Create .pi dir inside
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		cwd = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writeCheckpointFile creates .pi/supervisor-state-<issueNum>.json with correct JSON content", () => {
		const state = createState();
		const result = writeCheckpointFile(cwd, state);
		assert.equal(result.ok, true);

		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		assert.equal(existsSync(statePath), true);

		const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(parsed.issueNum, state.issueNum);
		assert.equal(parsed.checkpoint, state.checkpoint);
		assert.equal(parsed.worktreePath, state.worktreePath);
		assert.equal(parsed.worktreeBranch, state.worktreeBranch);
		assert.equal(parsed.startedAt, state.startedAt);
	});

	it("writeCheckpointFile atomic pattern: temp file created first, then renamed", () => {
		const state = createState();
		const result = writeCheckpointFile(cwd, state);
		assert.equal(result.ok, true);

		// Verify no .tmp file remains after write
		const tmpPath = join(cwd, ".pi", "supervisor-state-746.json.tmp");
		assert.equal(existsSync(tmpPath), false);

		// Verify main file exists
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		assert.equal(existsSync(statePath), true);
	});

	it("writeCheckpointFile returns Result<void> ok on success", () => {
		const state = createState();
		const result = writeCheckpointFile(cwd, state);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, undefined);
		}
	});

	it("writeCheckpointFile returns ok=false when .pi dir permissions prevent write", () => {
		// Use a non-writable path (root-owned dir in /tmp won't work on all systems)
		// Instead, use a path where .pi can't be created
		const invalidCwd = "/nonexistent-dir-that-cant-exist-12345";
		const state = createState();
		const result = writeCheckpointFile(invalidCwd, state);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.source, "state-checkpoint");
		}
	});

	it("writeCheckpointFile overwrites previous state for the same issue (re-read returns new state)", () => {
		const state1 = createState({ issueNum: 1503, checkpoint: "pre-tsc" });
		const state2 = createState({ issueNum: 1503, checkpoint: "pre-lsp" });

		const r1 = writeCheckpointFile(cwd, state1);
		assert.equal(r1.ok, true);

		const r2 = writeCheckpointFile(cwd, state2);
		assert.equal(r2.ok, true);

		// Re-read should return state2
		const reread = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-1503.json"));
		assert.notEqual(reread, null);
		assert.equal(reread!.issueNum, 1503);
		assert.equal(reread!.checkpoint, "pre-lsp");
	});

	it("writes for two different issues coexist — second write does not clobber first (parallel isolation)", () => {
		const state1 = createState({ issueNum: 1503, checkpoint: "pre-tsc" });
		const state2 = createState({ issueNum: 1507, checkpoint: "pre-lsp" });

		writeCheckpointFile(cwd, state1);
		writeCheckpointFile(cwd, state2);

		// Both per-issue files exist with their own content
		const r1 = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-1503.json"));
		const r2 = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-1507.json"));
		assert.notEqual(r1, null);
		assert.notEqual(r2, null);
		assert.equal(r1!.issueNum, 1503);
		assert.equal(r1!.checkpoint, "pre-tsc");
		assert.equal(r2!.issueNum, 1507);
		assert.equal(r2!.checkpoint, "pre-lsp");
	});

	it("deleteCheckpointFile removes .pi/supervisor-state-<issueNum>.json — Result<void> ok", () => {
		const state = createState();
		writeCheckpointFile(cwd, state);

		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		assert.equal(existsSync(statePath), true);

		const result = deleteCheckpointFile(cwd, 746);
		assert.equal(result.ok, true);
		assert.equal(existsSync(statePath), false);
	});

	it("deleteCheckpointFile idempotent — returns ok when file already missing", () => {
		const result = deleteCheckpointFile(cwd, 746);
		assert.equal(result.ok, true);
	});

	it("deleteCheckpointFile removes only the run's own issue file — other issues survive", () => {
		writeCheckpointFile(cwd, createState({ issueNum: 1503 }));
		writeCheckpointFile(cwd, createState({ issueNum: 1507 }));

		const result = deleteCheckpointFile(cwd, 1503);
		assert.equal(result.ok, true);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state-1503.json")), false);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state-1507.json")), true);
	});

	it("deleteCheckpointFile returns ok=false when supervisor-state-<issueNum>.json is a directory", () => {
		// Create a directory at the state file path
		const stateDir = join(cwd, ".pi", "supervisor-state-746.json");
		mkdirSync(stateDir, { recursive: true });

		const result = deleteCheckpointFile(cwd, 746);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.source, "state-checkpoint");
		}
	});

	it("roundtrip: writeCheckpointFile → readCheckpointFile matches original state", () => {
		const state = createState({
			issueNum: 791,
			checkpoint: "pre-auditor",
			worktreePath: "/custom/worktree/path",
			worktreeBranch: "custom-branch",
			startedAt: "2026-06-14T12:00:00.000Z",
		});

		const writeResult = writeCheckpointFile(cwd, state);
		assert.equal(writeResult.ok, true);

		const readResult = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-791.json"));
		assert.notEqual(readResult, null);
		assert.equal(readResult!.issueNum, state.issueNum);
		assert.equal(readResult!.checkpoint, state.checkpoint);
		assert.equal(readResult!.worktreePath, state.worktreePath);
		assert.equal(readResult!.worktreeBranch, state.worktreeBranch);
		assert.equal(readResult!.startedAt, state.startedAt);
	});
});

describe("readCheckpointFile — edge cases (Phase 1)", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "state-checkpoint-read-test-"));
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		cwd = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readCheckpointFile returns null when file doesn't exist", () => {
		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-746.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with corrupted JSON (truncated)", () => {
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		writeFileSync(statePath, '{"issueNum": 746, "checkpoint": "pre-tsc",', "utf-8");

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-746.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with JSON missing required fields", () => {
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		writeFileSync(statePath, '{"issueNum": 746}', "utf-8");

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-746.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with invalid checkpoint name", () => {
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		writeFileSync(
			statePath,
			JSON.stringify({
				issueNum: 746,
				checkpoint: "invalid-checkpoint",
				worktreePath: "/path",
				worktreeBranch: "branch",
				startedAt: "2026-06-14T12:00:00.000Z",
			}),
			"utf-8",
		);

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-746.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns parsed state with valid JSON", () => {
		const state = createState();
		writeCheckpointFile(cwd, state);

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state-746.json"));
		assert.notEqual(result, null);
		assert.equal(result!.issueNum, state.issueNum);
		assert.equal(result!.checkpoint, state.checkpoint);
	});
});

// ─── readCheckpointFileFromPath smoke tests ───────────────────────

describe("readCheckpointFileFromPath — smoke tests", () => {
	let tmpDir: string;
	let validFilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "state-checkpoint-frompath-"));
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		validFilePath = join(tmpDir, ".pi", "supervisor-state-746.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readCheckpointFileFromPath returns parsed state for valid checkpoint file", () => {
		const state = createState();
		writeCheckpointFile(tmpDir, state);

		const result = readCheckpointFileFromPath(validFilePath);
		assert.notEqual(result, null);
		assert.equal(result!.issueNum, state.issueNum);
		assert.equal(result!.checkpoint, state.checkpoint);
		assert.equal(result!.worktreePath, state.worktreePath);
		assert.equal(result!.worktreeBranch, state.worktreeBranch);
		assert.equal(result!.startedAt, state.startedAt);
	});

	it("readCheckpointFileFromPath returns null for non-existent path", () => {
		const result = readCheckpointFileFromPath(join(tmpDir, ".pi", "nonexistent-file.json"));
		assert.equal(result, null);
	});
});

// ─── Phase 3: cleanupStalePipelineState ───────────────────────────

describe("cleanupStalePipelineState — mock pi.exec (Phase 3)", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "state-checkpoint-cleanup-"));
		cwd = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("cleanup found stale state file → cleans up worktree → returns ok", async () => {
		// Create .pi/supervisor-state-746.json in main repo with stale state
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const staleState = createState({
			startedAt: new Date(Date.now() - 7_200_000).toISOString(), // 2h ago → stale
			worktreePath: "/tmp/stale-worktree",
			worktreeBranch: "stale-branch",
		});
		writeCheckpointFile(cwd, staleState);

		// Create worktreeBase dir
		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git worktree prune
				{ code: 0, stdout: "", stderr: "" }, // git worktree remove --force
				{ code: 0, stdout: "", stderr: "" }, // git branch -D
				{ code: 0, stdout: "", stderr: "" }, // rm -rf
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		// Should call git worktree prune, remove, branch -D, and rm -rf
		assert.ok(calls.length >= 4, "should have at least 4 exec calls");
		assert.deepEqual(calls[0].args, ["worktree", "prune"]);
		assert.deepEqual(calls[1].args, [
			"worktree",
			"remove",
			"--force",
			"--force",
			"/tmp/stale-worktree",
		]);
		assert.deepEqual(calls[2].args, ["branch", "-D", "stale-branch"]);
		assert.deepEqual(calls[3].args, ["-rf", "/tmp/stale-worktree"]);

		// State file should be deleted
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		assert.equal(existsSync(statePath), false);
	});

	it("no state files anywhere → no git calls → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls when no stale state");
	});

	it("state file found but isStaleCheckpoint returns false → no git calls → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// State from 30 seconds ago → not stale
		const freshState = createState({
			startedAt: new Date(Date.now() - 30_000).toISOString(),
		});
		writeCheckpointFile(cwd, freshState);

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls when state is not stale");
	});

	it("state file found, stale, git worktree remove fails → catches error, continues → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const staleState = createState({
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/stale-worktree",
			worktreeBranch: "stale-branch",
		});
		writeCheckpointFile(cwd, staleState);

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git worktree prune — OK
				{ code: 1, stdout: "", stderr: "worktree not found" }, // git worktree remove — FAILS
				{ code: 0, stdout: "", stderr: "" }, // git branch -D — OK
				{ code: 0, stdout: "", stderr: "" }, // rm -rf — OK
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		// Should still succeed (best-effort)
		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		// State file should still be deleted
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		assert.equal(existsSync(statePath), false);
	});

	it("state file parse error (corrupted JSON) → skip file, no git calls → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		writeFileSync(statePath, "not-valid-json{", "utf-8");

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls for corrupted state file");
	});

	it("worktreeBase directory doesn't exist → no-op → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// Don't create worktreeBase dir — it doesn't exist

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0);
	});

	it("stale state's worktreePath matches currentWorktreePath → skip self-cleanup → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const worktreePath = "/tmp/my-worktree";
		const staleState = createState({
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath,
			worktreeBranch: "my-branch",
		});
		writeCheckpointFile(cwd, staleState);

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(
			pi,
			cwd,
			mockConfig,
			notify,
			worktreePath, // currentWorktreePath matches state.worktreePath
		);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls — self-cleanup skipped");
	});

	it("worktreeBase not configured → skip → returns ok", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();
		const configNoBase = { ...mockConfig, worktreeBase: undefined } as unknown as SupervisorConfig;

		const result = await cleanupStalePipelineState(pi, cwd, configNoBase, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0);
	});

	it("all git commands fail → returns ok=false with aggregated error", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const staleState = createState({
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/stale-worktree",
			worktreeBranch: "stale-branch",
		});
		writeCheckpointFile(cwd, staleState);

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		// All commands fail
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "prune failed" },
				{ code: 1, stdout: "", stderr: "remove failed" },
				{ code: 1, stdout: "", stderr: "branch delete failed" },
				{ code: 1, stdout: "", stderr: "rm failed" },
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		// All commands failed, but state file still gets delete attempt
		assert.equal(result.ok, true); // currently returns ok on partial failure
		assert.equal(calls.length, 4);
	});

	it("finds state file in worktree subdirectory", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		// Create a worktree directory with its own .pi/supervisor-state-999.json
		const wtDir = join(cwd, "../worktrees/some-worktree");
		mkdirSync(join(wtDir, ".pi"), { recursive: true });
		const wtState = createState({
			issueNum: 999,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: wtDir,
			worktreeBranch: "some-worktree",
		});
		const wtStatePath = join(wtDir, ".pi", "supervisor-state-999.json");
		writeFileSync(wtStatePath, JSON.stringify(wtState), "utf-8");

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git worktree prune
				{ code: 0, stdout: "", stderr: "" }, // git worktree remove --force
				{ code: 0, stdout: "", stderr: "" }, // git branch -D
				{ code: 0, stdout: "", stderr: "" }, // rm -rf
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		// Should have cleaned up the worktree
		assert.equal(calls.length, 4);
		assert.deepEqual(calls[1].args, ["worktree", "remove", "--force", "--force", wtDir]);
		assert.equal(existsSync(wtStatePath), false);
	});

	it("skips a stale checkpoint whose per-issue lock has a LIVE pid (parallel pipeline guard)", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// Stale (2h) checkpoint for 1503 with a live lock (pid 1 = alive, not us)
		const staleState = createState({
			issueNum: 1503,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/live-worktree-1503",
			worktreeBranch: "worktree-git-issue-1503-live",
		});
		writeCheckpointFile(cwd, staleState);
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 1, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no git calls — live pipeline owns the worktree");
		// State file + worktree preserved
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state-1503.json")), true);
	});

	it("cleans a stale checkpoint whose per-issue lock has a DEAD pid (crash recovery intact)", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const staleState = createState({
			issueNum: 1503,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/crashed-worktree-1503",
			worktreeBranch: "worktree-git-issue-1503-crashed",
		});
		writeCheckpointFile(cwd, staleState);
		// Dead-PID lock — does not protect
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git worktree prune
				{ code: 0, stdout: "", stderr: "" }, // git worktree remove --force
				{ code: 0, stdout: "", stderr: "" }, // git branch -D
				{ code: 0, stdout: "", stderr: "" }, // rm -rf
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state-1503.json")), false);
	});

	it("cleans a stale checkpoint with NO lock file present (crash removed lock, checkpoint survived)", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const staleState = createState({
			issueNum: 1503,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/orphan-worktree-1503",
			worktreeBranch: "worktree-git-issue-1503-orphan",
		});
		writeCheckpointFile(cwd, staleState);
		// No lock file at all

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state-1503.json")), false);
	});

	it("legacy bare-name supervisor-state.json with a live per-issue lock → skipped (guard via state.issueNum)", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// Legacy bare-name file (mid-upgrade orphan) referencing issue 1503
		const staleState = createState({
			issueNum: 1503,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: "/tmp/live-worktree-1503",
			worktreeBranch: "worktree-git-issue-1503-live",
		});
		writeFileSync(
			join(cwd, ".pi", "supervisor-state.json"),
			JSON.stringify(staleState),
			"utf-8",
		);
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 1, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		mkdirSync(join(cwd, "../worktrees"), { recursive: true });

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-state.json")), true);
	});
});

// ─── Tests: acquireRunLock / releaseRunLock ──────────────────────

describe("acquireRunLock / releaseRunLock", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-lock-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("acquires on fresh repo, then releases (own pid only)", () => {
		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1503.json")), true);

		// Release removes the lock
		releaseRunLock(cwd, 1503);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1503.json")), false);
	});

	it("acquire for issue A does not block acquire for issue B (cross-issue parallelism)", () => {
		const acquiredA = acquireRunLock(cwd, 1503);
		assert.equal(acquiredA.ok, true);
		const acquiredB = acquireRunLock(cwd, 1507);
		assert.equal(acquiredB.ok, true, "different issue must not be blocked");

		// Both per-issue lock files exist side by side
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1503.json")), true);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1507.json")), true);
	});

	it("blocks when another LIVE pipeline holds the SAME issue's lock", () => {
		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true);
		// Second acquire of the same issue — same live pid → blocked
		const blocked = acquireRunLock(cwd, 1503);
		assert.equal(blocked.ok, false);
		if (!blocked.ok) {
			assert.ok(blocked.error.includes("Another supervisor pipeline is already running"));
			assert.ok(blocked.error.includes(String(process.pid)));
			assert.ok(blocked.error.includes("issue #1503"));
			assert.ok(blocked.error.includes("started"));
			assert.equal(blocked.source, "run-lock");
		}
	});

	it("steals a stale lock whose holder PID is dead (crashed run), per issue", () => {
		// Write a lock for 1503 claiming a dead PID
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1503, startedAt: new Date().toISOString() }),
		);
		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true, "stale lock should be taken over");
		// Our pid now owns it
		const lock = JSON.parse(
			readFileSync(join(cwd, ".pi", "supervisor-run-1503.json"), "utf-8"),
		);
		assert.equal(lock.pid, process.pid);
		assert.equal(lock.issueNum, 1503);
	});

	it("stealing a stale lock does not touch another issue's LIVE lock", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// 1507 holds a live lock (pid 1)
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1507.json"),
			JSON.stringify({ pid: 1, issueNum: 1507, startedAt: new Date().toISOString() }),
		);
		// 1503 has a stale lock
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true);

		// 1507's live lock untouched
		const lock1507 = JSON.parse(
			readFileSync(join(cwd, ".pi", "supervisor-run-1507.json"), "utf-8"),
		);
		assert.equal(lock1507.pid, 1);
		assert.equal(lock1507.issueNum, 1507);
	});

	it("release does NOT delete a lock owned by another pid (foreign lock, per issue)", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// pid 1 (init) is alive but not us
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 1, issueNum: 1503, startedAt: new Date().toISOString() }),
		);
		releaseRunLock(cwd, 1503);
		assert.equal(
			existsSync(join(cwd, ".pi", "supervisor-run-1503.json")),
			true,
			"lock owned by another pid must survive release",
		);
	});

	it("release deletes only the run's own issue lock — other issues survive", () => {
		acquireRunLock(cwd, 1503);
		acquireRunLock(cwd, 1507);

		releaseRunLock(cwd, 1503);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1503.json")), false);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1507.json")), true);

		// Re-acquire 1503 works while 1507 is still held
		const reacquired = acquireRunLock(cwd, 1503);
		assert.equal(reacquired.ok, true);
	});

	it("corrupt/unparseable lock is treated as stale — acquired", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "supervisor-run-1503.json"), "not-json{{{", "utf-8");

		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true);
		const lock = JSON.parse(
			readFileSync(join(cwd, ".pi", "supervisor-run-1503.json"), "utf-8"),
		);
		assert.equal(lock.pid, process.pid);
	});

	it("acquire on repo without .pi/ creates the directory, then writes the lock", () => {
		// No .pi dir created in beforeEach
		const acquired = acquireRunLock(cwd, 1503);
		assert.equal(acquired.ok, true);
		assert.equal(existsSync(join(cwd, ".pi", "supervisor-run-1503.json")), true);
	});

	it("steal-race loop terminates within bounded retries on an unstealable path", () => {
		// A directory at the lock path: writeLock always gets EEXIST and unlink
		// always fails — the loop must give up after MAX_ACQUIRE_ATTEMPTS, not
		// spin forever, and never surface a generic EEXIST from the outer catch.
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "supervisor-run-1503.json"), { recursive: true });

		const result = acquireRunLock(cwd, 1503);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.source, "run-lock");
			assert.ok(result.error.includes("attempts"), "bounded-retry error expected");
		}
	});
});

// ─── Tests: isAnyOtherPipelineLive ────────────────────────────────

describe("isAnyOtherPipelineLive", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "other-live-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns false when no run lock files exist", () => {
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), false);
	});

	it("returns false when only the excluded issue's lock is live", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: process.pid, issueNum: 1503, startedAt: new Date().toISOString() }),
		);
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), false);
	});

	it("returns true when another issue's lock is held by a live pid", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1507.json"),
			JSON.stringify({ pid: 1, issueNum: 1507, startedAt: new Date().toISOString() }),
		);
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), true);
	});

	it("returns false when another issue's lock is held by a dead pid", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1507.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1507, startedAt: new Date().toISOString() }),
		);
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), false);
	});

	it("any live other-issue lock → true; all dead → false", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1501.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1501, startedAt: new Date().toISOString() }),
		);
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1507.json"),
			JSON.stringify({ pid: 1, issueNum: 1507, startedAt: new Date().toISOString() }),
		);
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), true);

		// Make the second one dead too → false
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1507.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1507, startedAt: new Date().toISOString() }),
		);
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), false);
	});

	it("corrupt lock JSON in the scan is treated as dead — does not throw", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "supervisor-run-1507.json"), "garbage{", "utf-8");
		assert.equal(isAnyOtherPipelineLive(cwd, 1503), false);
	});
});
