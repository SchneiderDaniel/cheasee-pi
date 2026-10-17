import { describe, it, beforeEach, mock, afterEach } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { join, resolve } from "node:path";

import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type {
	SupervisorConfig,
	AgentRunResult,
	PrConflictInfo,
	PrCreationResult,
} from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

const AGENT_FILE_CONTENT = `---
name: developer
description: Test developer agent
tools: read,bash,write,edit
model: test-model
extensions: ""
skills: ""
thinking: medium
---

You are a test developer agent.
`;

function createTempWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "merge-wt-"));
	const agentDir = resolve(dir, ".pi/extensions/supervisor/agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(resolve(agentDir, "developer.md"), AGENT_FILE_CONTENT, "utf-8");
	return dir;
}

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];

const tempDirs: string[] = [];

beforeEach(() => {
	widgetCalls = [];
});

afterEach(() => {
	mock.restoreAll();
	for (const d of tempDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	tempDirs.length = 0;
});

function makeConflictInfo(hasConflict: boolean): PrConflictInfo {
	return {
		number: 123,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-foo-issue",
		baseRefName: "main",
	};
}

function createMockMergePort(hasConflict: boolean = true): GitHubPort {
	return createMockGitHubPort({
		listPullRequestsForBranch: async () => makeConflictInfo(hasConflict),
	});
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
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(
	confirmResult: boolean = true,
): ExtensionCommandContext & { setWidgetCalls: Array<{ id: string; lines?: string[] }> } {
	const setWidgetCalls: Array<{ id: string; lines?: string[] }> = [];
	return {
		cwd: "/repo",
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: (id: string, lines?: string[]) => {
				setWidgetCalls.push({ id, lines });
			},
			confirm: async () => confirmResult,
		},
		setWidgetCalls,
	} as unknown as ExtensionCommandContext & {
		setWidgetCalls: Array<{ id: string; lines?: string[] }>;
	};
}

function makeConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return {
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
		...overrides,
	} as SupervisorConfig;
}

function prListResult(hasConflict: boolean): string {
	return JSON.stringify([
		{
			number: 123,
			mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
			mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
			headRefName: "worktree-git-issue-42-foo-issue",
			baseRefName: "main",
		},
	]);
}

const BRANCH = "worktree-git-issue-42-foo-issue";

function createGateMockRunner(result?: Partial<AgentRunResult>) {
	return mock.fn(
		async (..._args: any[]) =>
			({
				output: "Conflicts resolved",
				success: true,
				agentName: "developer",
				toolCount: 5,
				tokenCount: 1000,
				durationMs: 30000,
				textOutput: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
				textOnly: "Successfully resolved merge conflicts\nCONFLICTS_RESOLVED",
				summaryLine: "Successfully resolved merge conflicts",
				errorOutput: "",
				...(result || {}),
			}) as AgentRunResult,
	);
}

function makeDirtyInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: true,
		mergeable: "NOT_MERGEABLE",
		mergeStateStatus: "DIRTY",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeCleanInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: false,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function makeUnknownInfo(): PrConflictInfo {
	return {
		number: 123,
		hasConflict: false,
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
		headRefName: BRANCH,
		baseRefName: "main",
	};
}

function createSequencedPort(
	listValues: Array<PrConflictInfo | null>,
	trackCalls?: PortCall[],
): GitHubPort {
	let idx = 0;
	return createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async (_branch: string, _repo: string) => {
				const v = listValues[Math.min(idx, listValues.length - 1)] ?? null;
				idx++;
				return v;
			},
			createPullRequest: async () => ({ number: 456 }),
			updatePullRequest: async () => {},
			postIssueComment: async () => {},
		},
		trackCalls,
	);
}

function makeFailedPrResult(rebaseConflicts?: string[]): PrCreationResult {
	return {
		success: false,
		error: "Rebase conflicts in 1 file(s)",
		source: "pr-creation",
		pushSkipped: true,
		...(rebaseConflicts ? { rebaseConflicts } : {}),
	};
}

describe("ensurePrReadyForDone() — pre-Done readiness gate", () => {
	const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };
	it("existing clean PR → { ok: true }, no resolution, no createPrOnApproval retry", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([makeCleanInfo()], calls);
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "clean PR passes the gate");
		assert.equal(execCalls.length, 0, "no git calls for a clean PR");
		assert.equal(runner.mock.callCount(), 0, "no developer dispatch for a clean PR");
		assert.ok(
			calls.some((c) => c.method === "listPullRequestsForBranch"),
			"PR existence/mergeability was checked",
		);
	});
	it("PR dirty (#1457) → auto-merge → push → re-poll clean → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort(
			[makeDirtyInfo(), makeDirtyInfo(), makeCleanInfo(), makeCleanInfo()],
			calls,
		);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 0, stdout: "merge ok", stderr: "" }, // tryAutoMerge merge
				{ code: 0, stdout: "push ok", stderr: "" }, // resolveBranchConflicts push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "dirty PR resolved by auto-merge passes the gate");
		assert.equal(runner.mock.callCount(), 0, "auto-merge success does not dispatch developer");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 4, "initial + settle + re-check + re-settle = 4 polls");
		// Port call order: dirty, dirty (settled), clean, clean (settled)
		assert.equal(listCalls[0]?.args[0], BRANCH);
		// Exec order: fetch → merge → push
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "merge", "push"],
			"auto-merge fetch → merge → push",
		);
	});
	it("PR dirty + auto-merge fails → developer dispatch succeeds → createPrOnApproval retried exactly once → re-poll → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort(
			[makeDirtyInfo(), makeDirtyInfo(), null, makeCleanInfo(), makeCleanInfo()],
			calls,
		);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
				{ code: 0, stdout: "fetch ok", stderr: "" }, // retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // retry push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "dev-resolved dirty PR passes the gate");
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch");
		const createCalls = calls.filter((c) => c.method === "createPullRequest");
		assert.equal(createCalls.length, 1, "createPrOnApproval retried exactly once");
	});
	it("rebaseConflicts + no PR (#1455) → resolution proceeds → developer dispatch → retry → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([null, null, makeCleanInfo(), makeCleanInfo()], calls);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
				{ code: 0, stdout: "fetch ok", stderr: "" }, // retry rebase fetch
				{ code: 0, stdout: "rebase ok", stderr: "" }, // retry rebase
				{ code: 0, stdout: "push ok", stderr: "" }, // retry push
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			makeFailedPrResult(["src/a.ts"]),
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "#1455 recovery path passes the gate");
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch");
		assert.equal(
			calls.filter((c) => c.method === "createPullRequest").length,
			1,
			"createPrOnApproval retried once after resolution",
		);
	});
	it("developer fails → { ok: false } + blockerNote mentioning manual intervention; exactly 1 dispatch, no retry loop", async () => {
		const execCalls: ExecCall[] = [];
		const port = createSequencedPort([null]);
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const runner = createGateMockRunner({ success: false, summaryLine: "Could not resolve" });
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			wt,
			BRANCH,
			makeFailedPrResult(["src/a.ts"]),
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, false, "developer failure blocks the gate");
		assert.ok(
			verdict.blockerNote!.includes("Manual intervention"),
			"blockerNote must mention manual intervention",
		);
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch, no retry loop");
		assert.equal(
			execCalls.filter((c) => c.args[0] === "push").length,
			0,
			"no push when resolution failed",
		);
	});
});
