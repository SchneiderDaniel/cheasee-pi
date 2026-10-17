import { describe, it, beforeEach, afterEach } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig } from "../../config/types.ts";

import type { NotifyFn } from "../../pipeline/helpers.ts";

import {
	isStaleCheckpoint,
	readCheckpointFileFromPath,
	writeCheckpointFile,
	deleteCheckpointFile,
	type SupervisorCheckpointState,
	type CheckpointName,
} from "../../pipeline/state-checkpoint.ts";

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
			// Production `pi.exec` RESOLVES with {code} on a non-zero exit — it never
			// rejects. A rejecting mock would hide code-check bugs (the ignore-code
			// audit findings), so mirror production here.
			return Promise.resolve({ ...result, killed: false });
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

	it("returns false when startedAt is exactly 1h ago (boundary — not strictly older)", (t) => {
		// Freeze the clock so the test's `Date.now()` and the function's
		// `Date.now()` are the same instant. A real clock advances between the
		// two calls, flipping the exact boundary to stale under load (flake).
		const now = Date.now();
		t.mock.timers.enable({ apis: ["Date"], now });
		const state = createState({
			startedAt: new Date(now - 3_600_000).toISOString(), // exactly 1h ago
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
describe("readCheckpointFileFromPath — untrusted-shape rejection (Phase 3)", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "state-checkpoint-shape-"));
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		filePath = join(tmpDir, ".pi", "supervisor-state-746.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function write(overrides: Record<string, unknown>): void {
		writeFileSync(filePath, JSON.stringify({ ...createState(), ...overrides }), "utf-8");
	}

	it("rejects an empty worktreePath", () => {
		write({ worktreePath: "" });
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});

	it("rejects a relative worktreePath", () => {
		write({ worktreePath: "worktrees/x" });
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});

	it("rejects an empty worktreeBranch", () => {
		write({ worktreeBranch: "" });
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});

	it("rejects non-integer issueNum (1.5, NaN)", () => {
		write({ issueNum: 1.5 });
		assert.equal(readCheckpointFileFromPath(filePath), null);
		write({ issueNum: NaN }); // JSON.stringify → null
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});

	it("rejects issueNum 0 and negative values", () => {
		write({ issueNum: 0 });
		assert.equal(readCheckpointFileFromPath(filePath), null);
		write({ issueNum: -1 });
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});

	it("returns the state for a valid absolute worktreePath and integer issueNum > 0", () => {
		write({});
		const res = readCheckpointFileFromPath(filePath);
		assert.notEqual(res, null);
		assert.equal(res!.issueNum, 746);
		assert.equal(res!.checkpoint, "pre-tsc");
	});

	it("regression: missing fields, malformed JSON and unknown checkpoint names still yield null", () => {
		writeFileSync(filePath, '{"issueNum": 746}', "utf-8");
		assert.equal(readCheckpointFileFromPath(filePath), null);

		writeFileSync(filePath, '{"issueNum": 746,', "utf-8");
		assert.equal(readCheckpointFileFromPath(filePath), null);

		write({ checkpoint: "bogus" });
		assert.equal(readCheckpointFileFromPath(filePath), null);
	});
});
