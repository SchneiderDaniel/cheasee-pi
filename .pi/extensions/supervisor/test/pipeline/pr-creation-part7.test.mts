import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig, PipelineAgentResult, PrConflictInfo } from "../../config/types.ts";

import type { GitHubPort } from "../../github/ports.ts";

import { createMockGitHubPort } from "../helper/mock-github-port.ts";

import type { PortCall } from "../helper/mock-github-port.ts";

import { readFileSync } from "node:fs";

import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

interface NotifyCall {
	message: string;
	level: string;
}

function makeConflictInfo(prNumber: number = 123, hasConflict: boolean = false): PrConflictInfo {
	return {
		number: prNumber,
		hasConflict,
		mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
		headRefName: "worktree-git-issue-42-test",
		baseRefName: "main",
	};
}

function createMockComparePort(aheadBy: number = 3, existingPrNumber?: number): GitHubPort {
	return createMockGitHubPort({
		compareBranches: async () => aheadBy,
		listPullRequestsForBranch: async () =>
			existingPrNumber ? makeConflictInfo(existingPrNumber) : null,
		createPullRequest: async () => ({ number: 456 }),
		updatePullRequest: async () => {},
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
			const result = results[idx++];
			if (!result || result.code !== 0) {
				const errMsg = result?.stderr || result?.stdout || `Command failed: ${cmd}`;
				return Promise.reject(new Error(errMsg));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createResolvingPi(
	results: Array<{ code: number; stdout: string; stderr: string; killed?: boolean }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++] ?? { code: 0, stdout: "", stderr: "" };
			return Promise.resolve({ killed: false, ...result });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function flushQueue(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createMockCtx(notifyCalls?: NotifyCall[]): ExtensionCommandContext {
	const notifyLog = notifyCalls || [];
	return {
		cwd: "/repo",
		ui: {
			notify: (message: string, level?: string) => {
				notifyLog.push({ message, level: level || "info" });
			},
			setStatus: () => {},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

const mockConfig: SupervisorConfig = {
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
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

describe("createPrOnApproval()", () => {
	describe("createPrOnApproval - Rebase orchestration: Phase 2.5", () => {
		it("Regression: existing PR update path works when rebase succeeds", async () => {
			const execCalls: ExecCall[] = [];
			const notifyCalls: NotifyCall[] = [];
			const pi = createMockPi(
				[
					{ code: 0, stdout: "fetch ok", stderr: "" },
					{ code: 0, stdout: "rebase ok", stderr: "" },
					{ code: 0, stdout: "push ok", stderr: "" },
				],
				execCalls,
			);
			const ctx = createMockCtx(notifyCalls);
			const port = createMockComparePort(3, 789);

			const result = await createPrOnApproval(
				pi,
				ctx,
				42,
				"Test issue",
				mockConfig as any,
				[mockAgentResult],
				"/worktrees/wt-42",
				"worktree-git-issue-42-test",
				undefined,
				undefined,
				undefined,
				port,
			);

			assert.ok(result.success, "should succeed");
			assert.equal(result.prNumber, 789, "should reference existing PR");
			assert.equal(result.wasUpdate, true, "should be marked as update");
		});
	});
});
describe("createPrOnApproval — structural: verifyAhead helper extraction", () => {
	const source = readFileSync(".pi/extensions/supervisor/pipeline/pr-creation.ts", "utf-8");

	it("contains async function verifyAhead with AheadVerdict return type", () => {
		assert.ok(
			source.includes("async function verifyAhead("),
			"pr-creation.ts must contain async function verifyAhead",
		);
		assert.ok(
			source.includes("Promise<AheadVerdict>"),
			"verifyAhead must return Promise<AheadVerdict>",
		);
	});

	it("AheadVerdict type includes 'ahead', 'not-ahead', 'fail-closed' states with reason on fail-closed", () => {
		assert.ok(source.includes('{ state: "ahead" }'), "AheadVerdict must include 'ahead' state");
		assert.ok(
			source.includes('{ state: "not-ahead" }'),
			"AheadVerdict must include 'not-ahead' state",
		);
		assert.ok(
			source.includes('{ state: "fail-closed"; reason: string }'),
			"AheadVerdict must include 'fail-closed' state with reason: string",
		);
	});

	it("createPrOnApproval call site dispatches on verdict with 3 branches (ahead, not-ahead, fail-closed)", () => {
		const lines = source.split("\n");
		// Find the verdict dispatch in the call site
		const verdictAwait = lines.findIndex((l) => l.includes("verdict = await verifyAhead("));
		assert.notEqual(verdictAwait, -1, "call site must await verifyAhead");

		// Check for the three dispatch branches
		const notAheadBranch = lines.findIndex((l) => l.includes('verdict.state === "not-ahead"'));
		const failClosedBranch = lines.findIndex((l) => l.includes('verdict.state === "fail-closed"'));
		const aheadComment = lines.findIndex((l) => l.includes('verdict.state === "ahead"'));

		assert.notEqual(notAheadBranch, -1, "call site must dispatch on 'not-ahead' verdict");
		assert.notEqual(failClosedBranch, -1, "call site must dispatch on 'fail-closed' verdict");
		assert.notEqual(aheadComment, -1, "call site must have comment for 'ahead' verdict");

		// Verify ahead is handled as a comment (meaning proceed without return)
		assert.ok(
			lines.some((l) => l.includes('verdict.state === "ahead" — proceed')),
			"call site must handle 'ahead' as proceed (no early return)",
		);
	});

	it("verifyAhead signature includes pi, port, config, headBranch, worktreePath, log — does NOT accept ctx", () => {
		// Find the function signature
		const fnStart = source.indexOf("async function verifyAhead(");
		assert.notEqual(fnStart, -1, "must find verifyAhead function");
		const fnDecl = source.slice(fnStart, fnStart + 300); // Read enough to cover params

		assert.ok(fnDecl.includes("pi: ExtensionAPI"), "verifyAhead must accept pi: ExtensionAPI");
		assert.ok(fnDecl.includes("port: GitHubPort"), "verifyAhead must accept port: GitHubPort");
		assert.ok(
			fnDecl.includes("config: SupervisorConfig"),
			"verifyAhead must accept config: SupervisorConfig",
		);
		assert.ok(fnDecl.includes("headBranch: string"), "verifyAhead must accept headBranch: string");
		assert.ok(
			fnDecl.includes("worktreePath: string"),
			"verifyAhead must accept worktreePath: string",
		);
		assert.ok(
			fnDecl.includes("log: ReturnType<typeof getDebugLogger>"),
			"verifyAhead must accept log: ReturnType<typeof getDebugLogger>",
		);
		// Verify ctx is NOT in the parameter list
		const closeParen = fnDecl.indexOf("): Promise<AheadVerdict>");
		const paramSection = fnDecl.slice(0, closeParen);
		assert.ok(
			!paramSection.includes("ctx"),
			"verifyAhead must NOT accept ctx parameter — UX is caller's responsibility",
		);
	});
});
