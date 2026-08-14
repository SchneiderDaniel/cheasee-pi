// ─── Tests: stages/empty-worktree.ts (issue #1533 extraction) ────
// Unit tests for the signal gatherers + 3-way dispatch extracted from
// runAgentLoop (Bug #1343). Fail-open/fail-closed semantics preserved:
// git failure → changeOnMain=false (loop back), port failure → warn +
// loop back, port comment/close throw → collector warn, still stop.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { ClosingPrRef, GitHubPort } from "../../github/ports.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import type { PortCall } from "../helper/mock-github-port.ts";
import {
	gatherChangeOnMain,
	gatherOpenPrs,
	dispatchEmptyWorktreeAction,
	handleEmptyWorktree,
} from "../../pipeline/stages/index.ts";
import type { EmptyWorktreeAction } from "../../pipeline/empty-worktree-policy.ts";
import type { ExecFn } from "../../pipeline/helpers.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";

const CONFIG = {
	repo: "owner/repo",
	defaultBranch: "main",
	branchPrefix: "worktree-git-issue-",
} as unknown as SupervisorConfig;
const ISSUE = 1533;
const WT = "/tmp/wt";

type ExecResult = { code: number; stdout: string; stderr: string; killed: boolean };
function execFn(results: Array<ExecResult | (() => Promise<ExecResult>)>): ExecFn {
	const queue = [...results];
	return async (cmd, args, _opts) => {
		const next = queue.shift();
		if (next === undefined) throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
		if (typeof next === "function") return await next();
		return next;
	};
}

function notifySpy(): { ctx: ExtensionCommandContext } {
	const ctx = {
		ui: { notify: mock.fn(), setStatus: () => {}, setWidget: mock.fn(), confirm: async () => true },
	} as unknown as ExtensionCommandContext;
	return { ctx };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", killed: false });

describe("gatherChangeOnMain — changeOnMain signal (issue #1533)", () => {
	it("gitCherryContains true → true (no diff fallback)", async () => {
		// `git cherry main HEAD` output all "- " prefixed → already upstream.
		const fn = execFn([ok("- abc123\n- def456")]);
		assert.equal(await gatherChangeOnMain(fn, WT, "main"), true);
	});

	it("cherry empty + diff code 0 → true (clean worktree)", async () => {
		const fn = execFn([ok(""), ok("")]); // cherry empty → diff --quiet code 0
		assert.equal(await gatherChangeOnMain(fn, WT, "main"), true);
	});

	it("cherry empty + diff code 1 → false", async () => {
		const fn = execFn([ok(""), { code: 1, stdout: "", stderr: "dirty", killed: false }]);
		assert.equal(await gatherChangeOnMain(fn, WT, "main"), false);
	});

	it("diff throws → false (fail-open loop-back)", async () => {
		const fn = execFn([ok(""), () => Promise.reject(new Error("git boom"))]);
		assert.equal(await gatherChangeOnMain(fn, WT, "main"), false);
	});
});

describe("gatherOpenPrs — open-PR signal (issue #1533)", () => {
	it("returns [] when no PRs reference the issue", async () => {
		const port = createMockGitHubPort({ getClosingPrsForIssue: async () => [] });
		assert.deepEqual(await gatherOpenPrs(port, ISSUE, CONFIG.repo), []);
	});

	it("returns the closing-PR refs", async () => {
		const refs: ClosingPrRef[] = [
			{ number: 42, sha: "abc", source: "closing-keyword", branch: "fix", state: "open" },
		];
		const port = createMockGitHubPort({ getClosingPrsForIssue: async () => refs });
		assert.deepEqual(await gatherOpenPrs(port, ISSUE, CONFIG.repo), refs);
	});

	it("propagates port failure (caller forces changeOnMain=false + warns)", async () => {
		const port = createMockGitHubPort({
			getClosingPrsForIssue: async () => {
				throw new Error("API down");
			},
		});
		await assert.rejects(() => gatherOpenPrs(port, ISSUE, CONFIG.repo), /API down/);
	});
});

describe("dispatchEmptyWorktreeAction — 3-way dispatch (issue #1533)", () => {
	function base(portCalls: PortCall[]): {
		ctx: ExtensionCommandContext;
		port: GitHubPort;
		collector: ErrorCollector;
	} {
		const port = createMockGitHubPort({}, portCalls);
		return { ctx: notifySpy().ctx, port, collector: new ErrorCollector() };
	}

	it("action null → { stop: false } (fall through to auditor), no port calls", async () => {
		const portCalls: PortCall[] = [];
		const { ctx, port, collector } = base(portCalls);
		const outcome = await dispatchEmptyWorktreeAction(
			null,
			ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			execFn([]),
			WT,
			"main",
		);
		assert.deepEqual(outcome, { stop: false });
		assert.equal(portCalls.length, 0, "no comment/close on classifier null");
	});

	it("kind loop → { stop: true, reason }, no comment/close", async () => {
		const portCalls: PortCall[] = [];
		const { ctx, port, collector } = base(portCalls);
		const action: EmptyWorktreeAction = {
			kind: "loop",
			reason:
				"No commits on worktree branch and required changes not present on main — looping back to Implementation.",
		};
		const outcome = await dispatchEmptyWorktreeAction(
			action,
			ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			execFn([]),
			WT,
			"main",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("No commits"));
		assert.equal(portCalls.length, 0, "loop never posts comments or closes");
	});

	it("kind close → { stop: true, 'Changes already on main…' }, comment + closeIssue", async () => {
		const portCalls: PortCall[] = [];
		const { ctx, port, collector } = base(portCalls);
		const action: EmptyWorktreeAction = {
			kind: "close",
			resolvedBy: { sha: "abc123", prNumber: 0, source: "main-branch" },
		};
		const fn = execFn([ok("abc123")]); // fetchResolvedByInfo: git log -1 main
		const outcome = await dispatchEmptyWorktreeAction(
			action,
			ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			fn,
			WT,
			"main",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("Changes already on main"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(methods.includes("postIssueComment"), "resolution comment posted");
		assert.ok(methods.includes("closeIssue"), "issue closed");
		const comment = portCalls.find((c) => c.method === "postIssueComment")!.args[2] as string;
		assert.ok(comment.includes("Issue Already Resolved"), "comment is the resolved-by builder");
	});

	it("kind close + port throw → collector warn, still { stop: true }", async () => {
		const port = createMockGitHubPort({
			postIssueComment: async () => {
				throw new Error("comment boom");
			},
			closeIssue: async () => {},
		});
		const collector = new ErrorCollector();
		const action: EmptyWorktreeAction = {
			kind: "close",
			resolvedBy: { sha: "abc123", prNumber: 0, source: "main-branch" },
		};
		const fn = execFn([ok("abc123")]);
		const outcome = await dispatchEmptyWorktreeAction(
			action,
			notifySpy().ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			fn,
			WT,
			"main",
		);
		assert.ok(outcome.stop, "stop even when closing fails");
		const records = collector.flush("handler");
		assert.ok(
			records.some((r) => r.message.includes("Failed to close issue")),
			"port failure surfaced via collector",
		);
	});

	it("kind leaveOpenForPr → { stop: true, 'Open PR #N…' }, comment posted, closeIssue NOT called", async () => {
		const portCalls: PortCall[] = [];
		const { ctx, port, collector } = base(portCalls);
		const action: EmptyWorktreeAction = { kind: "leaveOpenForPr", prNumber: 42, branch: "fix" };
		const outcome = await dispatchEmptyWorktreeAction(
			action,
			ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			execFn([]),
			WT,
			"main",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("Open PR #42"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(methods.includes("postIssueComment"), "PR link comment posted");
		assert.ok(!methods.includes("closeIssue"), "issue NOT closed on leave-open");
		const comment = portCalls.find((c) => c.method === "postIssueComment")!.args[2] as string;
		assert.ok(comment.includes("Open PR #42"), "comment links the open PR");
	});

	it("kind leaveOpenForPr + comment throw → collector warn, still { stop: true }", async () => {
		const port = createMockGitHubPort({
			postIssueComment: async () => {
				throw new Error("comment boom");
			},
		});
		const collector = new ErrorCollector();
		const action: EmptyWorktreeAction = { kind: "leaveOpenForPr", prNumber: 7, branch: "fix" };
		const outcome = await dispatchEmptyWorktreeAction(
			action,
			notifySpy().ctx,
			port,
			collector,
			ISSUE,
			CONFIG,
			execFn([]),
			WT,
			"main",
		);
		assert.ok(outcome.stop, "stop even when comment posting fails");
		const records = collector.flush("handler");
		assert.ok(
			records.some((r) => r.message.includes("Failed to post PR link comment")),
			"comment failure surfaced via collector",
		);
	});
});

describe("handleEmptyWorktree — signal gathering + dispatch (issue #1533)", () => {
	function port(
		prs: unknown[],
		portCalls: PortCall[],
		opts?: Partial<{ postIssueComment: () => Promise<void>; closeIssue: () => Promise<void> }>,
	): GitHubPort {
		return createMockGitHubPort(
			{
				getClosingPrsForIssue: async () => prs as never,
				postIssueComment: opts?.postIssueComment ?? (async () => {}),
				closeIssue: opts?.closeIssue ?? (async () => {}),
			},
			portCalls,
		);
	}

	it("no commits + no changeOnMain + no PRs → loop back { stop: true }", async () => {
		const portCalls: PortCall[] = [];
		const p = port([], portCalls);
		// rev-list count "0" → hasCommits false; cherry empty; diff code 1 → not on main
		const fn = execFn([ok("0"), ok(""), { code: 1, stdout: "", stderr: "dirty", killed: false }]);
		const outcome = await handleEmptyWorktree(
			{ exec: fn } as never,
			notifySpy().ctx,
			CONFIG,
			p,
			undefined,
			ISSUE,
			WT,
			"worktree-git-issue-1533-x",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("No commits"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(!methods.includes("postIssueComment"), "no comment on loop-back");
		assert.ok(!methods.includes("closeIssue"), "no close on loop-back");
	});

	it("no commits + changeOnMain (diff clean) → close flow", async () => {
		const portCalls: PortCall[] = [];
		const p = port([], portCalls);
		// rev-list "0"; cherry empty; diff code 0 → changeOnMain true; close.
		const fn = execFn([ok("0"), ok(""), ok(""), ok("abc123")]); // last: fetchResolvedByInfo git log
		const outcome = await handleEmptyWorktree(
			{ exec: fn } as never,
			notifySpy().ctx,
			CONFIG,
			p,
			undefined,
			ISSUE,
			WT,
			"worktree-git-issue-1533-x",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("Changes already on main"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(methods.includes("postIssueComment"), "resolution comment posted");
		assert.ok(methods.includes("closeIssue"), "issue closed");
	});

	it("open PR exists → leave open (comment, closeIssue NOT called)", async () => {
		const portCalls: PortCall[] = [];
		const p = port(
			[{ number: 99, sha: "def", source: "branch-head", branch: "pr-branch", state: "open" }],
			portCalls,
		);
		const fn = execFn([ok("0"), ok(""), ok("")]); // cherry empty + diff clean
		const outcome = await handleEmptyWorktree(
			{ exec: fn } as never,
			notifySpy().ctx,
			CONFIG,
			p,
			undefined,
			ISSUE,
			WT,
			"worktree-git-issue-1533-x",
		);
		assert.ok(outcome.stop);
		if (outcome.stop) assert.ok(outcome.stopReason.includes("Open PR #99"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(methods.includes("postIssueComment"), "PR link comment posted");
		assert.ok(!methods.includes("closeIssue"), "issue NOT closed when a PR targets it");
	});

	it("getClosingPrsForIssue throws → loop back (fail-open)", async () => {
		const portCalls: PortCall[] = [];
		const p = createMockGitHubPort(
			{
				getClosingPrsForIssue: async () => {
					throw new Error("API down");
				},
				postIssueComment: async () => {},
			},
			portCalls,
		);
		// rev-list "0"; cherry empty; diff code 0 would be changeOnMain=true, but the
		// port failure forces changeOnMain=false → loop (case 1), never close.
		const fn = execFn([ok("0"), ok(""), ok("")]);
		const outcome = await handleEmptyWorktree(
			{ exec: fn } as never,
			notifySpy().ctx,
			CONFIG,
			p,
			undefined,
			ISSUE,
			WT,
			"worktree-git-issue-1533-x",
		);
		assert.ok(outcome.stop, "loop-back outcome");
		if (outcome.stop) assert.ok(outcome.stopReason.includes("No commits"));
		const methods = portCalls.map((c) => c.method);
		assert.ok(!methods.includes("postIssueComment"), "no close attempt after port failure");
		assert.ok(!methods.includes("closeIssue"), "no close attempt after port failure");
	});
});
