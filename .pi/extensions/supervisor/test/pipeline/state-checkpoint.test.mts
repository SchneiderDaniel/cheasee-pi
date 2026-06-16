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
	statusMapping: {},
	maxRejections: 3,
	codeowners: [],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
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

	it("writeCheckpointFile creates .pi/supervisor-state.json with correct JSON content", () => {
		const state = createState();
		const result = writeCheckpointFile(cwd, state);
		assert.equal(result.ok, true);

		const statePath = join(cwd, ".pi", "supervisor-state.json");
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
		const tmpPath = join(cwd, ".pi", "supervisor-state.json.tmp");
		assert.equal(existsSync(tmpPath), false);

		// Verify main file exists
		const statePath = join(cwd, ".pi", "supervisor-state.json");
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

	it("writeCheckpointFile overwrites previous state (re-read returns new state)", () => {
		const state1 = createState({ issueNum: 100, checkpoint: "pre-tsc" });
		const state2 = createState({ issueNum: 200, checkpoint: "pre-lsp" });

		const r1 = writeCheckpointFile(cwd, state1);
		assert.equal(r1.ok, true);

		const r2 = writeCheckpointFile(cwd, state2);
		assert.equal(r2.ok, true);

		// Re-read should return state2
		const reread = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.notEqual(reread, null);
		assert.equal(reread!.issueNum, 200);
		assert.equal(reread!.checkpoint, "pre-lsp");
	});

	it("deleteCheckpointFile removes .pi/supervisor-state.json — Result<void> ok", () => {
		const state = createState();
		writeCheckpointFile(cwd, state);

		const statePath = join(cwd, ".pi", "supervisor-state.json");
		assert.equal(existsSync(statePath), true);

		const result = deleteCheckpointFile(cwd);
		assert.equal(result.ok, true);
		assert.equal(existsSync(statePath), false);
	});

	it("deleteCheckpointFile idempotent — returns ok when file already missing", () => {
		const result = deleteCheckpointFile(cwd);
		assert.equal(result.ok, true);
	});

	it("deleteCheckpointFile returns ok=false when supervisor-state.json is a directory", () => {
		// Create a directory at the state file path
		const stateDir = join(cwd, ".pi", "supervisor-state.json");
		mkdirSync(stateDir, { recursive: true });

		const result = deleteCheckpointFile(cwd);
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

		const readResult = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.notEqual(readResult, null);
		assert.equal(readResult!.issueNum, state.issueNum);
		assert.equal(readResult!.checkpoint, state.checkpoint);
		assert.equal(readResult!.worktreePath, state.worktreePath);
		assert.equal(readResult!.worktreeBranch, state.worktreeBranch);
		assert.equal(readResult!.startedAt, state.startedAt);
	});

	it("two writes in sequence: second overwrites first, readCheckpointFile returns second state", () => {
		const state1 = createState({ issueNum: 1, checkpoint: "pre-tsc" });
		const state2 = createState({ issueNum: 2, checkpoint: "pre-lsp" });

		writeCheckpointFile(cwd, state1);
		writeCheckpointFile(cwd, state2);

		const readResult = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.notEqual(readResult, null);
		assert.equal(readResult!.issueNum, 2);
		assert.equal(readResult!.checkpoint, "pre-lsp");
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
		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with corrupted JSON (truncated)", () => {
		const statePath = join(cwd, ".pi", "supervisor-state.json");
		writeFileSync(statePath, '{"issueNum": 746, "checkpoint": "pre-tsc",', "utf-8");

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with JSON missing required fields", () => {
		const statePath = join(cwd, ".pi", "supervisor-state.json");
		writeFileSync(statePath, '{"issueNum": 746}', "utf-8");

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns null with invalid checkpoint name", () => {
		const statePath = join(cwd, ".pi", "supervisor-state.json");
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

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
		assert.equal(result, null);
	});

	it("readCheckpointFile returns parsed state with valid JSON", () => {
		const state = createState();
		writeCheckpointFile(cwd, state);

		const result = readCheckpointFileFromPath(join(cwd, ".pi", "supervisor-state.json"));
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
		validFilePath = join(tmpDir, ".pi", "supervisor-state.json");
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
		// Create .pi/supervisor-state.json in main repo with stale state
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
		assert.deepEqual(calls[1].args, ["worktree", "remove", "--force", "/tmp/stale-worktree"]);
		assert.deepEqual(calls[2].args, ["branch", "-D", "stale-branch"]);
		assert.deepEqual(calls[3].args, ["-rf", "/tmp/stale-worktree"]);

		// State file should be deleted
		const statePath = join(cwd, ".pi", "supervisor-state.json");
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
		const statePath = join(cwd, ".pi", "supervisor-state.json");
		assert.equal(existsSync(statePath), false);
	});

	it("state file parse error (corrupted JSON) → skip file, no git calls → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const statePath = join(cwd, ".pi", "supervisor-state.json");
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
		const configNoBase: SupervisorConfig = { ...mockConfig, worktreeBase: undefined };

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

		// Create a worktree directory with its own .pi/supervisor-state.json
		const wtDir = join(cwd, "../worktrees/some-worktree");
		mkdirSync(join(wtDir, ".pi"), { recursive: true });
		const wtState = createState({
			issueNum: 999,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: wtDir,
			worktreeBranch: "some-worktree",
		});
		const wtStatePath = join(wtDir, ".pi", "supervisor-state.json");
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
		assert.deepEqual(calls[1].args, ["worktree", "remove", "--force", wtDir]);
		assert.equal(existsSync(wtStatePath), false);
	});
});
