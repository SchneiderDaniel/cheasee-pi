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
	it("finally clears status + agent-developer widget after ok:true verdict", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort([makeCleanInfo()], calls);
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const statusCalls: Array<[string, string | undefined]> = [];
		(ctx as any).ui.setStatus = (id: string, status?: string) => statusCalls.push([id, status]);

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

		assert.equal(verdict.ok, true);
		assert.deepEqual(
			statusCalls[statusCalls.length - 1],
			["supervisor", undefined],
			"status cleared in finally on ok:true",
		);
		assert.ok(
			(ctx as any).setWidgetCalls.some(
				(w: { id: string; lines?: string[] }) =>
					w.id === "agent-developer" && w.lines === undefined,
			),
			"agent-developer widget cleared in finally on ok:true",
		);
	});
	it("finally clears status + agent-developer widget after ok:false verdict", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi([], execCalls);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const statusCalls: Array<[string, string | undefined]> = [];
		(ctx as any).ui.setStatus = (id: string, status?: string) => statusCalls.push([id, status]);

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
		assert.deepEqual(
			statusCalls[statusCalls.length - 1],
			["supervisor", undefined],
			"status cleared in finally on ok:false",
		);
		assert.ok(
			(ctx as any).setWidgetCalls.some(
				(w: { id: string; lines?: string[] }) =>
					w.id === "agent-developer" && w.lines === undefined,
			),
			"agent-developer widget cleared in finally on ok:false",
		);
	});
});
describe("handlePostPipelineMerge() — rebaseConflicts (#1455 no-PR) backstop", () => {
	it("no rebaseConflicts + no PR → unchanged 'No PR found' early return (regression)", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi([], execCalls);
		const ctx = createMockCtx(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(result, false, "early return, no conflict work");
		assert.equal(execCalls.length, 0, "no git calls when no PR and no rebaseConflicts");
	});

	it("no PR + rebaseConflicts set → skips early return, proceeds to resolution", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" }, // tryAutoMerge fetch
				{ code: 1, stdout: "", stderr: "merge failed" }, // tryAutoMerge merge fails
				{ code: 0, stdout: "src/a.ts\n", stderr: "" }, // diff-filter=U
				{ code: 0, stdout: "", stderr: "" }, // merge --abort
			],
			execCalls,
		);
		const runner = createGateMockRunner();
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
			["src/a.ts"],
		);

		assert.equal(result, false, "resolution succeeded → no unresolved conflicts");
		assert.equal(runner.mock.callCount(), 1, "developer dispatched for #1455 resolution");
		const fetchCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "fetch");
		assert.ok(fetchCalls.length > 0, "auto-merge fetch ran — early return was skipped");
	});

	it("no PR + rebaseConflicts + developer fails → returns true (unresolved)", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
		});
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const runner = createGateMockRunner({ success: false, summaryLine: "Failed" });
		const ctx = createMockCtx(true);
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		const result = await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			port,
			["src/a.ts"],
		);

		assert.equal(result, true, "unresolved conflicts reported when developer fails");
	});
});
