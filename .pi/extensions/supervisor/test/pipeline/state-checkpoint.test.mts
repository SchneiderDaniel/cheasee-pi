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
	realpathSync,
	renameSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
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

// ─── Phase 3: validator tightening (untrusted JSON trust boundary) ─

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

// ─── Phase 4: cleanupStalePipelineState ───────────────────────────

describe("cleanupStalePipelineState — mock pi.exec (Phase 4)", () => {
	let tmpDir: string;
	let cwd: string;
	let baseDir: string;
	let mainWt: string;

	beforeEach(() => {
		tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "state-checkpoint-cleanup-")));
		// `worktreeBase: "../worktrees"` resolves against cwd, so the whole
		// fixture tree lives under tmpDir: cwd=<tmp>/repo, base=<tmp>/worktrees.
		cwd = join(tmpDir, "repo");
		baseDir = join(tmpDir, "worktrees");
		mainWt = join(tmpDir, "main-checkout");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(baseDir, { recursive: true });
		mkdirSync(mainWt, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	type WtSpec = string | { path: string; branch?: string | null; bare?: boolean };

	/**
	 * `git worktree list --porcelain -z` stdout: main checkout first, then linked.
	 * A plain path string derives its registered branch from the directory
	 * basename; pass a spec to pin the branch, make the entry bare, or make it
	 * detached (`branch: null`).
	 */
	function wtList(...specs: WtSpec[]): string {
		return specs
			.map((raw) => {
				const spec: { path: string; branch?: string | null; bare?: boolean } =
					typeof raw === "string" ? { path: raw } : raw;
				const fields = [`worktree ${spec.path}`];
				if (spec.bare) {
					fields.push("bare");
				} else if (spec.branch === null) {
					fields.push("HEAD 1111111111111111111111111111111111111111", "detached");
				} else {
					fields.push("HEAD 1111111111111111111111111111111111111111");
					fields.push(`branch ${spec.branch ?? `refs/heads/${basename(spec.path)}`}`);
				}
				return fields.join("\0") + "\0\0";
			})
			.join("");
	}

	const ok = { code: 0, stdout: "", stderr: "" };

	/** Write a stale checkpoint for `wt` and return its state-file path. */
	function writeStale(wt: string, overrides: Partial<SupervisorCheckpointState> = {}): string {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeCheckpointFile(
			cwd,
			createState({
				startedAt: new Date(Date.now() - 7_200_000).toISOString(), // 2h ago → stale
				worktreePath: wt,
				worktreeBranch: "stale-branch",
				...overrides,
			}),
		);
		return join(cwd, ".pi", `supervisor-state-${overrides.issueNum ?? 746}.json`);
	}

	it("stale in-base listed worktree → prune + remove + branch -D + rmSync fallback", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt);

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, { path: wt, branch: "refs/heads/stale-branch" }),
					stderr: "",
				}, // git worktree list --porcelain -z
				ok, // git worktree prune
				ok, // git worktree remove --force --force
				ok, // git branch -D --
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.deepEqual(calls[0].args, ["worktree", "list", "--porcelain", "-z"]);
		assert.deepEqual(calls[1].args, ["worktree", "prune"]);
		assert.deepEqual(calls[2].args, ["worktree", "remove", "--force", "--force", wt]);
		assert.deepEqual(calls[3].args, ["branch", "-D", "--", "stale-branch"]);

		// Fallback ran through fs.rmSync — the directory is gone and no
		// untrusted path ever reached a command's argv.
		assert.equal(existsSync(wt), false);
		assert.ok(
			calls.every((c) => c.cmd === "git"),
			"only git commands are exec'd",
		);

		assert.equal(existsSync(statePath), false);
	});

	it("worktreePath outside the worktree base → no destructive step, state file left", async () => {
		const outside = join(tmpDir, "main-checkout-copy");
		mkdirSync(outside);
		const statePath = writeStale(outside);

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: wtList(mainWt, outside), stderr: "" }], calls);
		const { notify, calls: notifyCalls } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1, "only the allowlist fetch — no destructive exec");
		assert.equal(existsSync(outside), true);
		assert.equal(existsSync(statePath), true, "state file left for manual cleanup");
		assert.ok(
			notifyCalls.some(
				(c) => c.level === "error" && c.msg.includes("Skipping stale worktree cleanup"),
			),
			"warning emitted",
		);
	});

	it("path inside base but absent from the worktree listing → destructive steps skipped", async () => {
		const wt = join(baseDir, "unlisted-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt);

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: wtList(mainWt), stderr: "" }], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(existsSync(wt), true);
		assert.equal(existsSync(statePath), true);
	});

	it("main-worktree entry inside the base is never removed even when listed", async () => {
		const mainWtInBase = join(baseDir, "main-checkout");
		mkdirSync(mainWtInBase);
		const statePath = writeStale(mainWtInBase);

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: wtList(mainWtInBase), stderr: "" }], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(existsSync(mainWtInBase), true);
		assert.equal(existsSync(statePath), true);
	});

	it("worktree carrying the default branch is never removed (main checkout in the bare layout)", async () => {
		// In the docker `--bare` + sibling-checkout layout the main checkout is an
		// ordinary listed linked worktree whose only distinguishing mark is the
		// branch it carries — the first listing entry is the bare dir itself.
		const mainInBase = join(baseDir, "main");
		mkdirSync(mainInBase);
		const statePath = writeStale(mainInBase);

		const listOut =
			`worktree ${join(tmpDir, ".bare")}\0bare\0\0` +
			`worktree ${mainInBase}\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0`;

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: listOut, stderr: "" }], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(existsSync(mainInBase), true);
		assert.equal(existsSync(statePath), true);
	});

	it("worktree list reports nothing → fail closed, no destructive step", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt);

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(existsSync(wt), true);
		assert.equal(existsSync(statePath), true);
	});

	it("git worktree remove fails → no rm fallback, no branch delete, state file left", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt);

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: wtList(mainWt, wt), stderr: "" },
				ok,
				{ code: 1, stdout: "", stderr: "not a worktree" },
				ok, // must never be reached
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 3, "no branch -D after a refused removal");
		assert.equal(existsSync(wt), true, "no recursive fallback after a refused removal");
		assert.equal(existsSync(statePath), true);
		assert.ok(notifyCalls.some((c) => c.level === "error"));
	});

	it("state branch that does not match the registered worktree branch → branch -D skipped", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		// Forged/inconsistent checkpoint: a real worktree path paired with an
		// unrelated branch name that must never be deleted.
		const statePath = writeStale(wt, { worktreeBranch: "feature/unrelated" });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, { path: wt, branch: "refs/heads/stale-worktree" }),
					stderr: "",
				},
				ok, // prune
				ok, // remove
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		// The verified worktree is still removed...
		assert.equal(existsSync(wt), false);
		assert.equal(existsSync(statePath), false);
		// ...but the unrelated branch name never reaches `git branch -D`.
		assert.equal(
			calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D"),
			false,
			"mismatched state branch must not be deleted",
		);
		assert.equal(calls.length, 3);
	});

	it("detached worktree entry → branch -D skipped", async () => {
		const wt = join(baseDir, "detached-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt, { worktreeBranch: "would-be-branch" });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[{ code: 0, stdout: wtList(mainWt, { path: wt, branch: null }), stderr: "" }, ok, ok],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(
			calls.some((c) => c.args[0] === "branch"),
			false,
			"no branch may be deleted for a detached entry",
		);
		assert.equal(existsSync(wt), false);
		assert.equal(existsSync(statePath), false);
	});

	it("git branch -D fails → failure surfaced and checkpoint retained", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt); // branch "stale-branch"

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, { path: wt, branch: "refs/heads/stale-branch" }),
					stderr: "",
				},
				ok, // prune
				ok, // remove
				{ code: 1, stdout: "", stderr: "branch is not fully merged" }, // branch -D
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		// The failed branch delete is surfaced instead of reported as success...
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /branch delete failed/);
		}
		assert.ok(
			notifyCalls.some(
				(c) => c.level === "error" && c.msg.includes("Failed to delete stale branch"),
			),
		);
		// ...the verified worktree removal still completed...
		assert.equal(existsSync(wt), false);
		// ...and the checkpoint is retained for manual cleanup.
		assert.equal(existsSync(statePath), true, "checkpoint retained when required cleanup fails");
	});

	it("two stale state files → exactly one git worktree list exec", async () => {
		const wt1 = join(baseDir, "wt-1");
		const wt2 = join(baseDir, "wt-2");
		mkdirSync(wt1);
		mkdirSync(wt2);
		const p1 = writeStale(wt1, { issueNum: 1 });
		const p2 = writeStale(wt2, { issueNum: 2 });

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(
						mainWt,
						{ path: wt1, branch: "refs/heads/stale-branch" },
						{ path: wt2, branch: "refs/heads/stale-branch" },
					),
					stderr: "",
				},
				ok,
				ok,
				ok,
				ok,
				ok,
				ok,
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(
			calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "list").length,
			1,
			"allowlist fetched once per run, not per state file",
		);
		assert.equal(existsSync(p1), false);
		assert.equal(existsSync(p2), false);
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
			worktreePath: join(baseDir, "fresh-worktree"),
		});
		writeCheckpointFile(cwd, freshState);

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls when state is not stale");
	});

	it("state file parse error (corrupted JSON) → skip file, no git calls → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const statePath = join(cwd, ".pi", "supervisor-state-746.json");
		writeFileSync(statePath, "not-valid-json{", "utf-8");

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no exec calls for corrupted state file");
	});

	it("a state file with a relative worktreePath is rejected before any destructive step", async () => {
		const statePath = writeStale("worktrees/relative-wt");

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0);
		assert.equal(existsSync(statePath), true);
	});

	it("git worktree prune failure is non-blocking — cleanup still completes, failure surfaced", async () => {
		const wt = join(baseDir, "stale-worktree");
		mkdirSync(wt);
		const statePath = writeStale(wt);

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, { path: wt, branch: "refs/heads/stale-branch" }),
					stderr: "",
				},
				{ code: 1, stdout: "", stderr: "prune failed" },
				ok,
				ok,
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		// Non-blocking: the removal still ran to completion...
		assert.equal(existsSync(wt), false);
		assert.equal(existsSync(statePath), false);
		// ...but the failed prune is surfaced through the result, not swallowed.
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /prune failed/);
		}
	});

	it("worktreeBase directory doesn't exist → no-op → returns ok", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		rmSync(baseDir, { recursive: true, force: true }); // base not created yet

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0);
	});

	it("stale state's worktreePath matches currentWorktreePath → skip self-cleanup → returns ok", async () => {
		const worktreePath = join(baseDir, "my-worktree");
		const statePath = writeStale(worktreePath, { worktreeBranch: "my-branch" });

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
		assert.equal(existsSync(statePath), true);
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

	it("finds state file in worktree subdirectory and cleans it up", async () => {
		// Create a worktree directory with its own .pi/supervisor-state-999.json
		const wtDir = join(baseDir, "some-worktree");
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
			[{ code: 0, stdout: wtList(mainWt, wtDir), stderr: "" }, ok, ok, ok],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.deepEqual(calls[2].args, ["worktree", "remove", "--force", "--force", wtDir]);
		// The state file lived inside the worktree, so the fallback delete takes it out
		assert.equal(existsSync(wtStatePath), false);
	});

	it("skips a stale checkpoint whose per-issue lock has a LIVE pid (parallel pipeline guard)", async () => {
		// Stale (2h) checkpoint for 1503 with a live lock (pid 1 = alive, not us)
		const wt = join(baseDir, "live-worktree-1503");
		mkdirSync(wt);
		const statePath = writeStale(wt, {
			issueNum: 1503,
			worktreeBranch: "worktree-git-issue-1503-live",
		});
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 1, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "no git calls — live pipeline owns the worktree");
		// State file + worktree preserved
		assert.equal(existsSync(statePath), true);
		assert.equal(existsSync(wt), true);
	});

	it("cleans a stale checkpoint whose per-issue lock has a DEAD pid (crash recovery intact)", async () => {
		const wt = join(baseDir, "crashed-worktree-1503");
		mkdirSync(wt);
		const statePath = writeStale(wt, {
			issueNum: 1503,
			worktreeBranch: "worktree-git-issue-1503-crashed",
		});
		// Dead-PID lock — does not protect
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 99999999, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, {
						path: wt,
						branch: "refs/heads/worktree-git-issue-1503-crashed",
					}),
					stderr: "",
				},
				ok,
				ok,
				ok,
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.equal(existsSync(statePath), false);
	});

	it("cleans a stale checkpoint whose per-issue lock has OUR OWN pid (production ordering: acquireRunLock runs before cleanup)", async () => {
		// A prior run crashed, leaving the checkpoint and a dead lock. The next
		// run's acquireRunLock stole the dead lock and rewrote it with
		// process.pid BEFORE cleanup runs, so the guard must not treat our own
		// live PID as a protective live pipeline.
		const wt = join(baseDir, "own-crashed-worktree-1503");
		mkdirSync(wt);
		const statePath = writeStale(wt, {
			issueNum: 1503,
			worktreeBranch: "worktree-git-issue-1503-own-crashed",
		});
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: process.pid, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, {
						path: wt,
						branch: "refs/heads/worktree-git-issue-1503-own-crashed",
					}),
					stderr: "",
				},
				ok,
				ok,
				ok,
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4, "own-pid lock must NOT protect — cleanup proceeds");
		assert.equal(existsSync(statePath), false);
	});

	it("cleans a stale checkpoint with NO lock file present (crash removed lock, checkpoint survived)", async () => {
		const wt = join(baseDir, "orphan-worktree-1503");
		mkdirSync(wt);
		const statePath = writeStale(wt, {
			issueNum: 1503,
			worktreeBranch: "worktree-git-issue-1503-orphan",
		});
		// No lock file at all

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, {
						path: wt,
						branch: "refs/heads/worktree-git-issue-1503-orphan",
					}),
					stderr: "",
				},
				ok,
				ok,
				ok,
			],
			calls,
		);
		const { notify } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 4);
		assert.equal(existsSync(statePath), false);
	});

	it("legacy bare-name supervisor-state.json with a live per-issue lock → skipped (guard via state.issueNum)", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// Legacy bare-name file (mid-upgrade orphan) referencing issue 1503
		const wt = join(baseDir, "live-worktree-1503");
		mkdirSync(wt);
		const staleState = createState({
			issueNum: 1503,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(),
			worktreePath: wt,
			worktreeBranch: "worktree-git-issue-1503-live",
		});
		writeFileSync(join(cwd, ".pi", "supervisor-state.json"), JSON.stringify(staleState), "utf-8");
		writeFileSync(
			join(cwd, ".pi", "supervisor-run-1503.json"),
			JSON.stringify({ pid: 1, issueNum: 1503, startedAt: new Date().toISOString() }),
		);

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
		const lock = JSON.parse(readFileSync(join(cwd, ".pi", "supervisor-run-1503.json"), "utf-8"));
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
		const lock = JSON.parse(readFileSync(join(cwd, ".pi", "supervisor-run-1503.json"), "utf-8"));
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
