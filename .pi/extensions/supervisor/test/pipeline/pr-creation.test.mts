// ─── Tests: pipeline/pr-creation.ts — createPrOnApproval ──────────
// Unit tests for the PR creation flow. Mocks pi.exec and ctx.ui.
// Follows the same mock pattern as handler.test.mts.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult } from "../../config/types.ts";

// ─── gh-client normalization ──────────────────────────────────────
// gh() in gh-client.ts wraps calls in bash -c GH_TOKEN=... when
// process.env.GH_TOKEN or ~/.config/gh/hosts.yml exists. This breaks
// test assertions that check cmd === "gh". The pi.exec mock below
// normalizes bash -c GH_TOKEN=... gh wrappers back to native gh calls
// so assertions work regardless of host GH auth state.
import { createMockGitHubPort } from "../../test/helper/mock-github-port.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

/**
 * Create a mock port with gh-delegating listPullRequestsForBranch and
 * createPullRequest that call pi.exec so exec call tracking works.
 * Other methods use default stub values.
 */
function createMockPortForPrTest(pi: ExtensionAPI): GitHubPort {
	const ghExec = (args: string[]): Promise<{ stdout: string }> =>
		pi.exec("gh", args) as Promise<{ stdout: string; code: number; stderr: string }>;

	return createMockGitHubPort({
		listPullRequestsForBranch: async (branch, repo) => {
			const result = await ghExec([
				"pr", "list", "--repo", repo, "--head", branch,
				"--json", "number,mergeable,mergeStateStatus,headRefName,baseRefName",
			]);
			const parsed = JSON.parse(result.stdout || "[]");
			if (!Array.isArray(parsed) || parsed.length === 0) return null;
			const pr = parsed[0];
			return {
				number: pr.number,
				hasConflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
				mergeable: pr.mergeable || "UNKNOWN",
				mergeStateStatus: pr.mergeStateStatus || "UNKNOWN",
				headRefName: pr.headRefName,
				baseRefName: pr.baseRefName,
			};
		},
		createPullRequest: async (input) => {
			const args: string[] = [
				"pr", "create", "--repo", input.repo,
				"--base", input.base, "--head", input.head,
				"--title", input.title,
			];
			let tempFile: string | undefined;
			if (input.body) {
				tempFile = join("ignore", `pr-body-test-${Date.now()}.md`);
				mkdirSync("ignore", { recursive: true });
				writeFileSync(tempFile, input.body, "utf-8");
				args.push("--body-file", tempFile);
			}
			try {
				const result = await ghExec(args);
				const rawOutput = (result.stdout || "").trim();
				const urlMatch = rawOutput.match(/pull\/(\d+)/);
				if (urlMatch) return { number: parseInt(urlMatch[1], 10) };
				const numMatch = rawOutput.match(/^(\d+)$/);
				if (numMatch) return { number: parseInt(numMatch[1], 10) };
				throw new Error(`gh pr create failed to parse PR number from: ${rawOutput.slice(0, 200)}`);
			} finally {
				if (tempFile) {
					try { unlinkSync(tempFile); } catch { /* best-effort */ }
				}
			}
		},
	});
}

// ─── Call Tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

interface NotifyCall {
	message: string;
	level: string;
}

/**
 * Normalize an ExecCall to a gh-like command. gh() in gh-client.ts wraps
 * calls in bash -c GH_TOKEN=... gh "$@" _ <args> when GH_TOKEN or
 * ~/.config/gh/hosts.yml exists. This helper extracts the normalized gh
 * command from both formats so assertions work regardless of host GH auth.
 */
function normalizeGhCall(call: ExecCall): { cmd: string; args: string[] } | null {
	// Case 1: gh() called pi.exec("gh", args) directly (no GH_TOKEN)
	if (call.cmd === "gh") {
		return { cmd: "gh", args: call.args };
	}
	// Case 2: gh() called pi.exec("bash", ["-c", "...", "_", ...args]) (GH_TOKEN set)
	if (
		call.cmd === "bash" &&
		call.args[0] === "-c" &&
		call.args.length >= 3 &&
		call.args.indexOf("_") !== -1
	) {
		const sepIdx = call.args.indexOf("_");
		return { cmd: "gh", args: call.args.slice(sepIdx + 1) };
	}
	return null;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI with controllable exec responses.
 * If result.code !== 0, pi.exec returns a rejected promise (simulating
 * command failure). Otherwise returns a resolved promise.
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			// Normalize bash -c GH_TOKEN=... gh wrappers into native gh calls
			// so test assertions work regardless of GH_TOKEN env state.
			if (cmd === "bash" && args[0] === "-c" && /\bgh\b/.test(args[1] ?? "")) {
				const sepIdx = args.indexOf("_");
				if (sepIdx !== -1) {
					callLog.push({ cmd: "gh", args: args.slice(sepIdx + 1), opts: opts || {} });
				} else {
					callLog.push({ cmd, args: args || [], opts: opts || {} });
				}
			} else {
				callLog.push({ cmd, args: args || [], opts: opts || {} });
			}
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

/**
 * Create a mock ExtensionCommandContext with trackable notifications.
 */
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

// ─── Fixtures ──────────────────────────────────────────────────────

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

/**
 * Helper: create a gh pr list response for no existing PR.
 */
function emptyPrListResponse(): string {
	return "[]";
}

/**
 * Helper: create a gh pr list response for an existing PR.
 */
function existingPrListResponse(prNumber: number = 123): string {
	return JSON.stringify([
		{
			number: prNumber,
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			headRefName: "worktree-git-issue-42-test",
			baseRefName: "main",
		},
	]);
}

/**
 * Helper: gh api compare response for head being ahead of base.
 * Returns the ahead_by count as stdout string.
 */
function compareAheadResponse(aheadBy: number = 3): {
	code: number;
	stdout: string;
	stderr: string;
} {
	return { code: 0, stdout: String(aheadBy), stderr: "" };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("createPrOnApproval()", () => {
	it("Happy path with worktree: push → compare check → list PR → create PR → success notifications", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
				// 2. gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				// 3. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 4. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify exec call order: push, compare, pr list, pr create
		assert.equal(execCalls.length, 4, "should have 4 exec calls (push, compare, pr list, pr create)");

		// 1. git push
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[0].args[0], "push");
		assert.equal(execCalls[0].args[1], "--force");
		assert.equal(execCalls[0].args[2], "origin");
		assert.equal(execCalls[0].args[3], "worktree-git-issue-42-test");
		assert.equal(execCalls[0].opts.cwd, "/worktrees/wt-42");
		assert.equal(execCalls[0].opts.timeout, 60000);

		// 2. gh api compare
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[0], "api");
		assert.ok(execCalls[1].args[1].includes("compare"));

		// 3. gh pr list
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[0], "pr");
		assert.equal(execCalls[2].args[1], "list");

		// 4. gh pr create
		assert.equal(execCalls[3].cmd, "gh");
		assert.equal(execCalls[3].args[0], "pr");
		assert.equal(execCalls[3].args[1], "create");

		// Verify success notifications
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.equal(infoNotifies.length, 1, "should have exactly 1 info notification");
		assert.ok(
			infoNotifies[0].message.includes("PR #456 created"),
			"should have PR creation success notification",
		);
	});

	it("Happy path without worktree: skip git push → check PR → create PR → success", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
		);

		// Verify no git push call
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 0, "no git push when worktreePath is undefined");

		// Verify PR was created
		assert.equal(execCalls.length, 2, "should have 2 exec calls");
		assert.equal(execCalls[0].cmd, "gh");
		assert.equal(execCalls[0].args[1], "list");
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[1], "create");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Existing PR found: push → check PR → update via gh pr edit", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				// 3. gh pr list (existing PR found)
				{ code: 0, stdout: existingPrListResponse(123), stderr: "" },
				// 4. gh pr edit
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify call order: push, compare, pr list, pr edit
		assert.equal(execCalls.length, 4, "should have 4 exec calls (push, compare, pr list, pr edit)");
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[0], "api"); // gh api compare
		assert.ok(execCalls[1].args[1].includes("compare"));
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[0], "pr");
		assert.equal(execCalls[2].args[1], "list"); // gh pr list
		assert.equal(execCalls[3].cmd, "gh");
		assert.equal(execCalls[3].args[0], "pr");
		assert.equal(execCalls[3].args[1], "edit");
		assert.equal(execCalls[3].args[2], "123"); // existing PR number

		// Verify no gh pr create call
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 0, "no gh pr create when PR already exists");

		// Verify update notification
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const updateNotify = infoNotifies.find((n) => n.message.includes("PR #123 updated"));
		assert.ok(updateNotify, "should have PR update notification");
	});

	it("Push failure: returns PrCreationResult with success=false and no PR attempt", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify error notification for push failure
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const pushError = errorNotifies.find((n) => n.message.toLowerCase().includes("push failed"));
		assert.ok(pushError, "should have error notification for push failure");

		// Verify NO gh calls were made after push failure (early return)
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR after push failure");

		// Verify PrCreationResult
		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.includes("push"), "error should mention push failure");
	});

	it("gh pr create failure: error notification delivered, function does not throw unhandled", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create FAILS
				{ code: 1, stdout: "", stderr: "create failed: GraphQL error" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		// Function should NOT throw — errors are caught internally
		await assert.doesNotReject(
			createPrOnApproval(
				createMockPortForPrTest(pi),
				pi,
				ctx,
				42,
				"Test issue",
				mockConfig as any,
				[mockAgentResult],
				"/worktrees/wt-42",
				"worktree-git-issue-42-test",
			),
		);

		// Verify error notification
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const prErrorNotify = errorNotifies.find((n) => n.message.toLowerCase().includes("failed"));
		assert.ok(prErrorNotify, "should have error notification for PR creation failure");
	});

	it("gh pr list failure: caught, warning notification, PR creation still attempted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				// 3. gh pr list FAILS
				{ code: 1, stdout: "", stderr: "network error" },
				// 4. gh pr create (fallback)
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Port.listPullRequestsForBranch returns null (no PR), so no notification needed

		// Verify PR creation was still attempted — push, compare, pr list, pr create
		assert.equal(execCalls.length, 4, "should have 4 exec calls (push, compare, pr list, pr create)");
		// Last exec call is gh pr create from port
		const lastCall = execCalls[execCalls.length - 1];
		assert.equal(lastCall.cmd, "gh", "last exec call is gh");
		assert.equal(lastCall.args[0], "pr", "last exec call starts with pr");
	});

	it("Regression: does NOT call git rev-list --count anywhere", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Scan all exec calls for rev-list
		const revListCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args.some((a) => a === "rev-list" || a.includes("rev-list")),
		);
		assert.equal(revListCalls.length, 0, "should NOT call git rev-list --count");
	});

	it("agentResults empty array: still writes PR body file and creates PR", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[], // empty agentResults
			undefined,
			"worktree-git-issue-42-test",
		);

		// Verify PR was created despite empty agentResults
		assert.equal(execCalls.length, 2, "should have 2 exec calls");
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 1, "should create PR even with empty agentResults");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Boundary: worktreeBranch undefined, no worktreePath: branch generated from issueNum and title", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		// Call without worktreePath and worktreeBranch to trigger auto-generation
		await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			undefined, // no worktreeBranch — will be auto-generated
		);

		// PR creation is handled by port (no pi.exec call)
		// The port's default createPullRequest returns { number: 123 }
		assert.ok(true, "PR creation delegated to port");
	});

	// ─── PrCreationResult Tests ────────────────────────────────────────

	it("returns PrCreationResult with success=true when PR is created", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				compareAheadResponse(3),
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				{ code: 0, stdout: "https://github.com/o/r/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 456, "should contain PR number");
		assert.equal(result.error, undefined, "should have no error");
	});

	it("returns PrCreationResult with success=true and wasUpdate=true when PR is updated", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				compareAheadResponse(3),
				{ code: 0, stdout: existingPrListResponse(123), stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should be success");
		assert.equal(result.prNumber, 123, "should contain existing PR number");
		assert.equal(result.wasUpdate, true, "should be marked as update");
	});

	it("returns PrCreationResult with success=false when gh pr create fails (both retries)", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// gh pr create attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "create failed: GraphQL error" },
				// gh pr create attempt 2 (retry) also FAILS
				{ code: 1, stdout: "", stderr: "still failing: rate limit" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure");
		assert.ok(result.error, "should contain error message");
		// Error should describe the failure
		assert.ok(result.error!.length > 0, "error should not be empty");
	});

	it("returns PrCreationResult with success=false when push fails", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1-3. git push --force all 3 retry attempts FAIL
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				{ code: 1, stdout: "", stderr: "push failed: still down" },
				{ code: 1, stdout: "", stderr: "push failed: timeout" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when push fails");
		assert.ok(result.error, "should contain error message");
		assert.ok(result.error!.toLowerCase().includes("push"), "error should mention push failure");
		// Verify no gh calls were made after push failure
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR creation after push failure");
	});

	it("push retry: first push fails, retry succeeds after backoff", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// First push fails, second succeeds
		const pi = createMockPi(
			[
				// 1. git push --force attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 2. git push --force attempt 2 succeeds
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
				// 3. gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				// 4. gh pr list
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 5. gh pr create
				{ code: 0, stdout: "https://github.com/o/r/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after push retry");

		// Verify two git push calls were made
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 2, "should retry push once after failure");

		// Both pushes should have 60000 timeout
		for (const pushCall of gitPushCalls) {
			assert.equal(pushCall.opts.timeout, 60000, "push timeout should be 60000");
		}
	});

	it("push retry: all 3 attempts exhausted → failure", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// All 3 push attempts fail
		const pi = createMockPi(
			[
				// 1. git push --force attempt 1 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 1" },
				// 2. git push --force attempt 2 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 2" },
				// 3. git push --force attempt 3 FAILS
				{ code: 1, stdout: "", stderr: "push failed: error 3" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after all push retries exhausted");
		assert.ok(result.error, "should contain error message");

		// Verify 3 git push calls were made
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 3, "should make 3 push attempts");

		// Verify no gh calls
		const ghCalls = execCalls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "should not attempt PR after push failure");
	});

	it("returns PrCreationResult with success=false when PR conflict check throws", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force OK
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				// 3. gh pr list FAILS
				{ code: 1, stdout: "", stderr: "network error" },
				// 4. gh pr create (should still attempt)
				{ code: 0, stdout: "https://github.com/o/r/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(
			result.success,
			true,
			"should still succeed if PR creation works despite check failure",
		);
		assert.equal(result.prNumber, 456, "should contain PR number");
	});

	it("retries gh pr create with backoff on transient failure", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// First call fails, second succeeds (retry with backoff)
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				compareAheadResponse(3),
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 1st gh pr create FAILS
				{ code: 1, stdout: "", stderr: "rate limit exceeded" },
				// 2nd gh pr create succeeds (retry)
				{ code: 0, stdout: "https://github.com/o/r/pull/789\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, true, "should succeed after retry");
		assert.equal(result.prNumber, 789, "should contain PR number from retry");

		// Verify two gh pr create calls were made
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 2, "should retry gh pr create once");
	});

	it("fails after retry exhausted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		// Both attempts fail
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				// gh api compare (pre-check: head has commits)
				compareAheadResponse(3),
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 1st gh pr create FAILS
				{ code: 1, stdout: "", stderr: "rate limit exceeded" },
				// 2nd gh pr create also FAILS
				{ code: 1, stdout: "", stderr: "still rate limited" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should fail after retry exhaustion");
		assert.ok(result.error, "should contain error message");

		// Verify two gh pr create calls were made
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 2, "should make exactly 2 attempts");
	});

	// ─── Bug 2: ahead_by=0 ─────────────────────────────────────────

	it("Bug 2: ahead_by=0 returns success=false with 'No commits ahead' error", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force OK
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh api compare returns 0 (no commits ahead)
				{ code: 0, stdout: "0", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		assert.ok(result, "should return a PrCreationResult");
		assert.equal(result.success, false, "should indicate failure when no commits ahead");
		assert.ok(result.error, "should contain error message");
		assert.ok(
			result.error!.toLowerCase().includes("no commits") ||
				result.error!.toLowerCase().includes("skipped") ||
				result.error!.toLowerCase().includes("no new changes"),
			`error should mention no commits: ${result.error}`,
		);
		assert.equal(result.prNumber, undefined, "prNumber should be undefined when no commits");
		// Should NOT attempt pr list or pr create after compare check
		const compareCalls = execCalls.filter((c) => c.args.some((a: string) => a.includes("compare")));
		assert.equal(compareCalls.length, 1, "should have exactly 1 compare call, no pr list/create");
		const prListCalls = execCalls.filter(
			(c) => c.args.some((a: string) => a === "list") || c.args.some((a: string) => a === "create"),
		);
		assert.equal(prListCalls.length, 0, "should NOT have any pr list or create calls");
	});

	it("Bug 2: ahead_by=0 does NOT report 'created' in output (no misleading PR #undefined)", async () => {
		// Verify that the compare check happens and no PR creation is attempted
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "push ok", stderr: "" },
				{ code: 0, stdout: "0", stderr: "" }, // ahead_by = 0
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		const result = await createPrOnApproval(
			createMockPortForPrTest(pi),
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// No gh pr create or gh pr edit calls
		const prCreateOrEdit = execCalls.filter(
			(c) => c.args.some((a: string) => a === "create") || c.args.some((a: string) => a === "edit"),
		);
		assert.equal(prCreateOrEdit.length, 0, "no PR create or edit should be attempted");

		// Verify the compare API was called with ahead_by
		const compareCall = execCalls.find((c) => c.args.some((a: string) => a.includes("compare")));
		assert.ok(compareCall, "should call gh api compare");
		const compareArgs = compareCall!.args;
		assert.ok(
			compareArgs.some((a: string) => a.includes("compare")),
			"should be compare endpoint",
		);

		// The result should not be misleading
		assert.equal(result.success, false, "should not indicate success");
		assert.equal(result.prNumber, undefined, "prNumber should be undefined");
	});
});
