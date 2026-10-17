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
} from "node:fs";

import { join, basename } from "node:path";

import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig } from "../../config/types.ts";

import type { NotifyFn } from "../../pipeline/helpers.ts";

import {
	writeCheckpointFile,
	cleanupStalePipelineState,
	acquireRunLock,
	releaseRunLock,
	isAnyOtherPipelineLive,
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
