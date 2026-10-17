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

describe("classifyMergeability() — mergeability verdict vocabulary", () => {
	it("clean PR (hasConflict=false, MERGEABLE, CLEAN) → { kind: 'clean', prNumber }", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(makeCleanInfo(), undefined), {
			kind: "clean",
			prNumber: 123,
		});
	});

	it("NOT_MERGEABLE + BLOCKED → clean (gated/blocked PRs must not false-block Done)", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const blocked = { ...makeCleanInfo(), mergeable: "NOT_MERGEABLE", mergeStateStatus: "BLOCKED" };
		assert.deepEqual(classifyMergeability(blocked, undefined), { kind: "clean", prNumber: 123 });
	});

	it("NOT_MERGEABLE + UNSTABLE → clean", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const unstable = {
			...makeCleanInfo(),
			mergeable: "NOT_MERGEABLE",
			mergeStateStatus: "UNSTABLE",
		};
		assert.deepEqual(classifyMergeability(unstable, undefined), { kind: "clean", prNumber: 123 });
	});

	it("NOT_MERGEABLE + BEHIND → clean", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const behind = { ...makeCleanInfo(), mergeable: "NOT_MERGEABLE", mergeStateStatus: "BEHIND" };
		assert.deepEqual(classifyMergeability(behind, undefined), { kind: "clean", prNumber: 123 });
	});

	it("hasConflict=true + MERGEABLE → dirty (mergeable field alone never overrides state)", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const info = { ...makeDirtyInfo(), mergeable: "MERGEABLE" };
		assert.deepEqual(classifyMergeability(info, undefined), { kind: "dirty", prNumber: 123 });
	});

	it("hasConflict=true + UNKNOWN → dirty (dirty beats computing)", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const info = { ...makeDirtyInfo(), mergeable: "UNKNOWN" };
		assert.deepEqual(classifyMergeability(info, undefined), { kind: "dirty", prNumber: 123 });
	});

	it("hasConflict=false + UNKNOWN → computing (UNKNOWN is never a verdict)", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(makeUnknownInfo(), undefined), { kind: "computing" });
	});

	it("info=null + failed w/ non-empty rebaseConflicts → no-pr rebase-conflicts", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(null, makeFailedPrResult(["src/a.ts"])), {
			kind: "no-pr",
			mode: "rebase-conflicts",
		});
	});

	it("info=null + failed w/o rebaseConflicts → no-pr creation-failed", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(null, makeFailedPrResult()), {
			kind: "no-pr",
			mode: "creation-failed",
		});
	});

	it("boundary: failed w/ empty rebaseConflicts array → creation-failed (length check, not array truthiness)", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(null, makeFailedPrResult([])), {
			kind: "no-pr",
			mode: "creation-failed",
		});
	});

	it("info=null + current success → no-pr propagating", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(
			classifyMergeability(null, { success: true, prNumber: 123, source: "pr-creation" }),
			{
				kind: "no-pr",
				mode: "propagating",
			},
		);
	});

	it("info=null + current undefined → no-pr propagating", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		assert.deepEqual(classifyMergeability(null, undefined), { kind: "no-pr", mode: "propagating" });
	});

	it("totality: never throws on any (info, current) combination; prNumber propagated on clean/dirty", async () => {
		const { classifyMergeability } = await import("../../pipeline/merge.ts");
		const infos: Array<PrConflictInfo | null> = [
			null,
			makeCleanInfo(),
			makeDirtyInfo(),
			makeUnknownInfo(),
		];
		const currents: Array<PrCreationResult | undefined> = [
			undefined,
			{ success: true, prNumber: 1, source: "pr-creation" },
			makeFailedPrResult(),
			makeFailedPrResult(["a.ts"]),
			makeFailedPrResult([]),
		];
		for (const info of infos) {
			for (const current of currents) {
				const klass = classifyMergeability(info, current);
				if (klass.kind === "clean" || klass.kind === "dirty") {
					assert.equal(
						klass.prNumber,
						info!.number,
						"prNumber propagated from info on clean/dirty",
					);
				}
			}
		}
	});
});
describe("awaitPrMergeability() — bounded mergeability poll", () => {
	const NO_BACKOFF = { attempts: 5, backoffMs: [0, 0, 0, 0, 0] };

	it("returns settled info on the first poll (1 port call)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort([makeCleanInfo()], calls);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.ok(info, "should return settled info");
		assert.equal(info!.hasConflict, false);
		assert.equal(
			calls.filter((c) => c.method === "listPullRequestsForBranch").length,
			1,
			"exactly 1 port call when first poll settles",
		);
	});

	it("polls unknown → unknown → clean (exactly 3 polls)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[makeUnknownInfo(), makeUnknownInfo(), makeCleanInfo()],
			calls,
		);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.ok(info, "should settle on the 3rd poll");
		assert.equal(info!.mergeStateStatus, "CLEAN");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 3, "exactly 3 polls for unknown → unknown → clean");
	});

	it("all 5 attempts UNKNOWN → returns null (bounded, no hang)", async () => {
		const calls: PortCall[] = [];
		const port = createSequencedPort(
			[
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
				makeUnknownInfo(),
			],
			calls,
		);
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);

		assert.equal(info, null, "null on poll exhaustion");
		const listCalls = calls.filter((c) => c.method === "listPullRequestsForBranch");
		assert.equal(listCalls.length, 5, "exactly 5 polls before exhaustion");
	});

	it("port throws → returns null (fail-open, no crash)", async () => {
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => {
				throw new Error("network error");
			},
		});
		const { awaitPrMergeability } = await import("../../pipeline/merge.ts");

		const info = await awaitPrMergeability(port, BRANCH, "owner/repo", NO_BACKOFF);
		assert.equal(info, null, "fail-open on port error");
	});
});
