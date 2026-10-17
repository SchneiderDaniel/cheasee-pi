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

describe("ensurePrReadyForDone() — additive seam coverage", () => {
	const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };
	it("port undefined → { ok: false } + 'GitHubPort not available' blockerNote", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			undefined,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, false, "no port fails closed");
		assert.ok(verdict.blockerNote!.includes("GitHubPort not available"));
		assert.equal(execCalls.length, 0, "no git calls without a port");
		assert.equal(runner.mock.callCount(), 0, "no developer dispatch without a port");
	});
	it("initial port read throws → { ok: true } fail-open; no git exec, no dispatch", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => {
				throw new Error("network down");
			},
		});

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "port error fails open");
		assert.equal(verdict.prCreationResult!.prNumber, 123, "current result preserved");
		assert.equal(execCalls.length, 0, "no git exec on port error");
		assert.equal(runner.mock.callCount(), 0, "no developer dispatch on port error");
	});
	it("no-PR + current success, PR appears during propagation poll → { ok: true }", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort([null, makeCleanInfo()], calls);
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "PR appearing during propagation poll passes");
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			2,
			"initial fetch + 1 propagation poll",
		);
	});
	it("no-PR + current success, PR stays invisible → propagation poll capped at min(attempts, 3), { ok: true } fail-open", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[
				null,
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
			],
			calls,
		);
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, true, "no PR after propagation poll fails open");
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			4,
			"1 initial + 3 propagation polls (capped at min(attempts, 3), not 5)",
		);
	});
	it("3 rounds all dirty with auto-merge success each round → loop exhausts → { ok: false } + 'did not settle'", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[
				makeDirtyInfo(),
				makeDirtyInfo(),
				makeDirtyInfo(),
				makeDirtyInfo(),
				makeDirtyInfo(),
				makeDirtyInfo(),
			],
			calls,
		);
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls); // default exec results: all git calls succeed
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);

		const { ensurePrReadyForDone } = await import("../../pipeline/merge.ts");
		const verdict = await ensurePrReadyForDone(
			pi,
			ctx,
			42,
			"Foo issue",
			makeConfig(),
			[],
			undefined,
			BRANCH,
			{ success: true, prNumber: 123, source: "pr-creation" },
			undefined,
			port,
			runner,
			NO_BACKOFF,
		);

		assert.equal(verdict.ok, false, "three dirty rounds without settling blocks the gate");
		assert.ok(verdict.blockerNote!.includes("did not settle"));
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			6,
			"2 polls per round × 3 rounds",
		);
		assert.equal(execCalls.length, 9, "3 git execs (fetch, merge, push) per round × 3 rounds");
	});
	it("dirty + dev dispatch → verdict.prCreationResult reflects retried createPrOnApproval (prNumber 456)", async () => {
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
				{ code: 0, stdout: "file1.ts\n", stderr: "" }, // diff-filter=U
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
		assert.equal(verdict.prCreationResult!.prNumber, 456, "retried creation result, not stale 123");
		assert.equal(runner.mock.callCount(), 1, "exactly 1 developer dispatch");
	});
});
