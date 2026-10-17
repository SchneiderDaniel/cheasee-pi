import { describe, it, beforeEach, afterEach } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";

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
	it("stale state file naming a worktree already gone → state file dropped, no error", async () => {
		// The worktree directory does not exist: cleanup completed but the
		// state-file unlink never ran (pipeline died between `git worktree
		// remove` and the unlink, or the worktree was removed out-of-band).
		// Every later supervisor run must not error on this — the stale JSON is
		// garbage and is dropped quietly.
		const wt = join(baseDir, "already-removed-worktree");
		const statePath = writeStale(wt); // no mkdirSync — the dir is gone

		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: wtList(mainWt), stderr: "" }], calls);
		const { notify, calls: notifyCalls } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1, "allowlist fetch only — nothing destructive");
		assert.equal(existsSync(statePath), false, "stale state file dropped");
		assert.equal(
			notifyCalls.some((c) => c.level === "error"),
			false,
			"an already-gone worktree is not an error",
		);
		assert.ok(
			notifyCalls.some((c) => c.level === "info" && c.msg.includes("already cleaned up")),
			"info notification emitted",
		);
	});
	it("stale state file naming a gone worktree that is still registered (locked phantom) → dropped, no error", async () => {
		// Regression: entrypoint.sh locks every worktree registration and
		// `git worktree prune` skips locked entries, so the admin state of a
		// deleted worktree survives and `git worktree list` keeps listing it.
		// The removal guard therefore still passes, `git worktree remove` then
		// fails with "is not a working tree", and the state file was retained —
		// erroring on every later supervisor run for an unrelated issue.
		const wt = join(baseDir, "locked-phantom-worktree");
		const statePath = writeStale(wt); // no mkdirSync — the dir is gone

		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 0,
					stdout: wtList(mainWt, { path: wt, branch: "refs/heads/stale-branch" }),
					stderr: "",
				}, // git worktree list --porcelain -z — still registered
			],
			calls,
		);
		const { notify, calls: notifyCalls } = createMockNotify();

		const result = await cleanupStalePipelineState(pi, cwd, mockConfig, notify);

		assert.equal(result.ok, true);
		assert.equal(calls.length, 1, "no worktree remove attempt for a missing directory");
		assert.equal(existsSync(statePath), false, "stale state file dropped");
		assert.equal(
			notifyCalls.some((c) => c.level === "error"),
			false,
			"a gone worktree is not an error even while still registered",
		);
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
});
