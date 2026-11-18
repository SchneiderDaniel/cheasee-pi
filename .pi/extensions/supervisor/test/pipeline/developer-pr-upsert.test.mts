// ─── Tests: upsertDeveloperPr (issue #1827) ──────────────────────
// The application operation: a PR must exist after the developer's commit
// is pushed and before any pre-audit gate runs. Skip paths, fail-soft,
// no extra git work.
//
// Fixtures live in ../helper/developer-pr-fixtures.mts; the workflow that
// calls this stage is covered by developer-pr-wiring.test.mts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { upsertDeveloperPr } from "../../pipeline/stages/index.ts";
import {
	baseDeps,
	createMockPi,
	makeNotify,
	prCalls,
	type ExecCall,
} from "../helper/developer-pr-fixtures.mts";

// ─── upsertDeveloperPr() ─────────────────────────────────────────

describe("upsertDeveloperPr()", () => {
	it("no worktreeBranch → not created, no PR calls, no throw", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const result = await upsertDeveloperPr({
			...baseDeps,
			worktreeBranch: undefined,
			pi: createMockPi([]),
			port,
		});

		assert.equal(result.success, false);
		assert.equal(portCalls.length, 0);
	});

	it("no port → skips the git pre-check and any PR call", async () => {
		const execCalls: ExecCall[] = [];

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "3\n", stderr: "" }], execCalls),
			port: undefined,
		});

		assert.equal(result.success, false);
		assert.equal(execCalls.length, 0);
	});

	it("no commits on the branch → skipped, zero PR calls", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort({}, portCalls);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "0\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, false);
		assert.equal(prCalls(portCalls).length, 0);
	});

	it("commits present → creates the PR for branch/base", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "3\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, true);
		assert.equal(result.prNumber, 456);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		const input = creates[0]!.args[0] as { base: string; head: string; body: string };
		assert.equal(input.base, "main");
		assert.equal(input.head, "worktree-git-issue-42-test");
		assert.ok(input.body.includes("Pipeline In Progress"));
		assert.ok(input.body.includes("Closes #42"));
	});

	it("git rev-list failure (code 128) → fail-safe, upsert still attempted", async () => {
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => null,
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const execCalls: ExecCall[] = [];
		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 128, stdout: "", stderr: "fatal" }], execCalls),
			port,
		});

		assert.equal(result.success, true);
		const creates = portCalls.filter((c) => c.method === "createPullRequest");
		assert.equal(creates.length, 1);
		assert.equal(execCalls.length, 1, "only the rev-list pre-check runs");
	});

	it("early path does no push/fetch/rebase and exactly one rev-list", async () => {
		const execCalls: ExecCall[] = [];
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => ({ number: 456 }),
		});

		await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }], execCalls),
			port,
		});

		const revLists = execCalls.filter((c) => c.args[0] === "rev-list");
		assert.equal(revLists.length, 1);
		assert.deepEqual(revLists[0]!.args, [
			"rev-list",
			"--count",
			"main..worktree-git-issue-42-test",
		]);
		for (const verb of ["push", "fetch", "rebase"]) {
			assert.equal(
				execCalls.filter((c) => c.args[0] === verb).length,
				0,
				`early upsert must not run git ${verb}`,
			);
		}
	});

	it("createPullRequest rejects → resolves, one error notify, one collector entry", async () => {
		const { calls: notifyCalls, notify } = makeNotify();
		const collector = new ErrorCollector();
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				throw new Error("500 internal");
			},
		});

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
			notify,
			collector,
		});

		assert.equal(result.success, false);
		const errors = notifyCalls.filter((n) => n.level === "error");
		assert.equal(errors.length, 1, "exactly one error notify");
		assert.match(errors[0]!.message, /PR/i);
		assert.equal(collector.flush("developer-pr").length, 1);
	});

	it("collector omitted on the failure path → resolves without throwing", async () => {
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				throw new Error("500 internal");
			},
		});

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
		});

		assert.equal(result.success, false);
	});

	it("PR lookup rejects but create succeeds → success, exactly one create", async () => {
		const { calls: notifyCalls, notify } = makeNotify();
		const portCalls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => {
					throw new Error("network error");
				},
				createPullRequest: async () => ({ number: 456 }),
			},
			portCalls,
		);

		const result = await upsertDeveloperPr({
			...baseDeps,
			pi: createMockPi([{ code: 0, stdout: "2\n", stderr: "" }]),
			port,
			notify,
		});

		assert.equal(result.success, true);
		assert.equal(portCalls.filter((c) => c.method === "createPullRequest").length, 1);
		const surfaced = notifyCalls.filter((n) => n.message.includes("PR conflict check failed"));
		assert.equal(surfaced.length, 1, "one lookup-failure notification surfaced");
	});
});
