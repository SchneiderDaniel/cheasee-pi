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

describe("handlePostPipelineMerge() — runAgentSubprocess dispatch", () => {
	function createPiWithFailedMerge(execCalls: ExecCall[]) {
		return createMockPi(
			[
				// PR conflict check is via port now, so no gh exec mock needed
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "merge failed" },
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
	}
	function createMockRunner(result?: Partial<AgentRunResult>) {
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
	async function dispatchWithConfig(config: unknown): Promise<{ arguments: any[] }> {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config as any,
			pi,
			ctx,
			wt,
			undefined,
			runner,
			createMockMergePort(true),
		);

		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.agent?.config?.name === "developer",
		);
		assert.equal(devCalls.length, 1, "developer dispatched for conflict resolution");
		return { arguments: devCalls[0]!.arguments as any[] };
	}
	it("calls runAgentSubprocess when auto-merge fails", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
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
		);

		assert.ok(
			runner.mock.callCount() > 0,
			"runAgentSubprocess should be called when auto-merge fails",
		);
	});
	it("dispatches developer agent for conflict resolution", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
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
		);

		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.agent?.config?.name === "developer",
		);
		assert.ok(devCalls.length > 0, "runAgentSubprocess should be called with developer agent");
	});
	it("passes correct params (cwd, maxToolCalls, agentTokenBudget)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const config = makeConfig({ maxToolCalls: 100, agentTokenBudget: 50000 });
		const wt = createTempWorktree();
		tempDirs.push(wt);
		const runner = createMockRunner();
		const port = createMockMergePort(true);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			wt,
			undefined,
			runner,
			createMockMergePort(true),
		);

		assert.ok(runner.mock.callCount() > 0, "should have runAgentSubprocess calls");
		const args = runner.mock.calls[0]?.arguments;
		assert.ok(args, "should have arguments");
		assert.equal(args[0]?.cwd, wt, "cwd should be worktree path");
		assert.equal(args[0]?.maxToolCalls, 100, "maxToolCalls should be passed through");
		assert.equal(args[0]?.agentTokenBudget, 50000, "agentTokenBudget should be passed through");
	});
	it("passes resolved per-agent timeout via shared resolver (agentTimeoutSec.developer)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig({ agentTimeoutSec: { developer: 60 } }),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			createMockMergePort(true),
		);

		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.agent?.config?.name === "developer",
		);
		assert.equal(devCalls.length, 1, "developer dispatched for conflict resolution");
		assert.equal(
			devCalls[0]!.arguments[0]?.timeoutMs,
			60_000,
			"agentTimeoutSec.developer=60 → 60_000ms",
		);
	});
	it("agentTimeoutSec.developer=0 → runner called with null (no longer the 30-min default)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createPiWithFailedMerge(execCalls);
		const ctx = createMockCtx(true);
		const runner = createMockRunner();
		const wt = createTempWorktree();
		tempDirs.push(wt);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig({ agentTimeoutSec: { developer: 0 } }),
			pi,
			ctx,
			wt,
			undefined,
			runner,
			createMockMergePort(true),
		);

		const devCalls = runner.mock.calls.filter(
			(c) => c.arguments[0]?.agent?.config?.name === "developer",
		);
		assert.equal(devCalls.length, 1, "developer dispatched");
		assert.equal(
			devCalls[0]!.arguments[0]?.timeoutMs,
			null,
			"configured 0 → null (timers disarmed)",
		);
	});
	it("legacy agentTimeoutsMin.developer=5 → 300_000ms; absent → 30-min default", async () => {
		const minConfig = makeConfig({ agentTimeoutsMin: { developer: 5 } });
		const evolved = makeConfig({});

		const minDispatch = await dispatchWithConfig(minConfig);
		const defaultDispatch = await dispatchWithConfig(evolved);

		assert.equal(
			minDispatch.arguments[0]?.timeoutMs,
			300_000,
			"legacy minutes alias resolves to ms",
		);
		assert.equal(
			defaultDispatch.arguments[0]?.timeoutMs,
			1_800_000,
			"no per-agent config → DEFAULT_AGENT_TIMEOUT_MS",
		);
	});
});
