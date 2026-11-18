// ─── Tests: handlePostAgentSuccess() — developer PR upsert wiring ─
// The workflow orchestration layer: commit+push, then delegate the PR
// upsert to upsertDeveloperPr. The stage's own behaviour is covered by
// developer-pr-upsert.test.mts; the source pins by developer-pr.test.mts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { handlePostAgentSuccess } from "../../pipeline/stages/index.ts";
import {
	baseRunResult,
	createMockCtx,
	createMockPi,
	developerResult,
	emptyFilteredData,
	makeNotify,
	mockConfig,
	prCalls,
} from "../helper/developer-pr-fixtures.mts";

// ─── handlePostAgentSuccess() wiring ─────────────────────────────

describe("handlePostAgentSuccess() — developer PR upsert wiring", () => {
	it("operator journey: commit+push then PR with in-progress body, returns true", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" }, // git add -A
			{ code: 0, stdout: "", stderr: "" }, // git diff --cached (nothing staged)
			{ code: 0, stdout: "up-to-date", stderr: "" }, // git push
			{ code: 0, stdout: "2\n", stderr: "" }, // git rev-list --count
		]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			new ErrorCollector(),
			undefined,
			makeNotify().notify,
			port,
			[developerResult],
		);

		assert.equal(ok, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		const input = creates[0]!.args[0] as { body: string };
		assert.ok(input.body.includes("Pipeline In Progress"));
		assert.ok(input.body.includes("Closes #42"));
	});

	it("commitAndPush failure → no PR call, returns false", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "fatal: could not add" }]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		assert.equal(ok, false);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("non-developer agents never upsert a PR", async () => {
		for (const agentName of ["architect", "test-designer", "researcher"]) {
			const portCalls: PortCall[] = [];
			const port = createMockGitHubPort({}, portCalls);
			const ok = await handlePostAgentSuccess(
				createMockPi([]),
				createMockCtx(),
				{ ...baseRunResult, agentName },
				agentName,
				42,
				mockConfig,
				emptyFilteredData,
				"/repo/worktree",
				"worktree-git-issue-42-test",
				"Test issue",
				undefined,
				undefined,
				undefined,
				port,
				[developerResult],
			);
			assert.equal(ok, true);
			assert.equal(prCalls(portCalls).length, 0, `${agentName} must not touch PRs`);
		}
	});

	it("developer with worktreeBranch undefined → no PR calls, returns true", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const ok = await handlePostAgentSuccess(
			createMockPi([]),
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		assert.equal(ok, true);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("legacy 14-arg call site (no agentResults) still resolves; empty agent table", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "up-to-date", stderr: "" },
			{ code: 0, stdout: "1\n", stderr: "" },
		]);

		const ok = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(ok, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		assert.ok((creates[0]!.args[0] as { body: string }).body.includes("| (none) |"));
	});

	it("agentResults are tabulated in the PR body", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);
		const pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "up-to-date", stderr: "" },
			{ code: 0, stdout: "1\n", stderr: "" },
		]);

		await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			baseRunResult,
			"developer",
			42,
			mockConfig,
			emptyFilteredData,
			"/repo/worktree",
			"worktree-git-issue-42-test",
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
			[developerResult],
		);

		const body = (
			portCalls.filter((c) => c.method === "createPullRequest")[0]!.args[0] as {
				body: string;
			}
		).body;
		assert.ok(body.includes("| developer |"), "developer entry rendered");
		assert.ok(body.includes("✓ SUCCESS"), "status rendered");
	});
});
