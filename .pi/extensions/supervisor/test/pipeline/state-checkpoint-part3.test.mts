import { describe, it, beforeEach, afterEach } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";

import { join, basename } from "node:path";

import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig } from "../../config/types.ts";

import type { NotifyFn } from "../../pipeline/helpers.ts";

import {
	writeCheckpointFile,
	cleanupStalePipelineState,
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
});
