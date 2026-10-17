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

describe("handlePostPipelineMerge() — worktree path resolution", () => {
	it("uses worktreePath when provided (7th param)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig();
		const explicitWorktreePath = `/repo/worktrees/${BRANCH}`;

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			explicitWorktreePath,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		assert.equal(
			fetchCall!.opts.cwd,
			explicitWorktreePath,
			"git fetch cwd should equal the provided worktreePath",
		);
	});

	it("falls back to resolvePath(cwd, worktreeBase, branch) when worktreePath is undefined", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig();

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/worktrees/${BRANCH}`;
		assert.equal(
			fetchCall!.opts.cwd,
			expectedPath,
			"git fetch cwd should equal resolvePath(cwd, worktreeBase, branch) fallback",
		);
	});

	it("handles worktreeBase without trailing separator correctly (no concat bug)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "../worktrees" });

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/worktrees/${BRANCH}`;
		const brokenPath = `/worktrees${BRANCH}`;
		assert.notEqual(fetchCall!.opts.cwd, brokenPath, "should NOT use broken string concat");
		assert.equal(fetchCall!.opts.cwd, expectedPath, "should use resolvePath-normalized path");
	});

	it("handles absolute worktreeBase correctly", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "/tmp/worktrees" });

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		const expectedPath = `/tmp/worktrees/${BRANCH}`;
		assert.equal(fetchCall!.opts.cwd, expectedPath, "should handle absolute worktreeBase");
	});

	it("uses worktreePath with trailing-slash base correctly", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);
		const config = makeConfig({ worktreeBase: "../worktrees/" });
		const explicitWorktreePath = `/repo/worktrees/${BRANCH}`;

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			explicitWorktreePath,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const fetchCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin",
		);
		assert.ok(fetchCall, "should have a git fetch call");
		assert.equal(fetchCall!.opts.cwd, explicitWorktreePath, "worktreePath takes precedence");
	});

	it("signature accepts 6 or 7 parameters without breaking existing callers", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(true);
		const config = makeConfig();

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		// No exec calls — conflict check is via port
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			config,
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			createMockMergePort(false),
		);

		// No exec calls should be made since no conflict and no auto-merge
		assert.equal(calls.length, 0, "no exec calls when no conflict");
	});

	it("does not call tryAutoMerge when user declines", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx(false);

		const { handlePostPipelineMerge } = await import("../../pipeline/merge.ts");
		await handlePostPipelineMerge(
			42,
			"Foo issue",
			"Done",
			makeConfig(),
			pi,
			ctx,
			undefined,
			undefined,
			undefined,
			createMockMergePort(true),
		);

		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 0, "no git calls when user declines merge");
	});
});
