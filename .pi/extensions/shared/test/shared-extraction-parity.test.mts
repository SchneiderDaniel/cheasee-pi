// ─── Phase 11: shared-extraction parity ──────────────────────────
// The Supervisor's worktree add, PR upsert and model resolution moved to
// `.pi/extensions/shared/` (issue #2138). These tests pin the behavior BEFORE
// and AFTER the move: same argv, same request sequence, same values, and no
// duplicate definition left behind.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { addWorktree } from "../git/worktree.ts";
import { upsertPullRequest, updatePullRequestBody } from "../github/pull-request.ts";
import { parseModelRef, resolveModel } from "../model/model-ref.ts";
import { createMockExec } from "../../supervisor/test/helpers/git-harness.mts";
import {
	createMockGitHubPort,
	type PortCall,
} from "../../supervisor/test/helper/mock-github-port.ts";

const ROOT = ".pi/extensions";

describe("shared/git/worktree.ts addWorktree", () => {
	it("emits `git worktree add -b <branch> <path> <start>`", async () => {
		const { exec, calls } = createMockExec([]);
		const added = await addWorktree(exec, {
			cwd: "/repo",
			path: "/repo-wt/branch",
			branch: "branch",
			startPoint: "main",
			createBranch: true,
		});
		assert.equal(added.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.cmd, "git");
		assert.deepEqual(calls[0]!.args, [
			"worktree",
			"add",
			"-b",
			"branch",
			"/repo-wt/branch",
			"main",
		]);
		assert.equal(calls[0]!.opts.cwd, "/repo");
	});

	it("attaches an existing branch without -b", async () => {
		const { exec, calls } = createMockExec([]);
		await addWorktree(exec, {
			cwd: "/repo",
			path: "/repo-wt/branch",
			branch: "branch",
			startPoint: "ignored",
			createBranch: false,
		});
		assert.deepEqual(calls[0]!.args, ["worktree", "add", "/repo-wt/branch", "branch"]);
	});

	it("returns git's stderr instead of throwing", async () => {
		const { exec } = createMockExec([{ code: 128, stdout: "", stderr: "already checked out" }]);
		const added = await addWorktree(exec, {
			cwd: "/repo",
			path: "/p",
			branch: "b",
			startPoint: "main",
		});
		assert.equal(added.ok, false);
		if (!added.ok) assert.match(added.error, /already checked out/);
	});

	it("is what Supervisor's createWorktree resolves through", () => {
		const source = readFileSync(`${ROOT}/supervisor/pipeline/worktree.ts`, "utf-8");
		assert.match(source, /from "\.\.\/\.\.\/shared\/git\/worktree\.ts"/);
		assert.match(source, /await addWorktree\(/);
		assert.doesNotMatch(source, /"git",\s*\[\s*"worktree",\s*"add",\s*"-b"/);
	});
});

describe("shared/github/pull-request.ts upsertPullRequest", () => {
	const base = {
		repo: "owner/repo",
		base: "main",
		head: "goal/x",
		title: "title",
		body: "body",
	};

	it("updates the body when a PR already exists and never creates a second", async () => {
		const createCalls: PortCall[] = [];
		const created = await upsertPullRequest({
			...base,
			port: createMockGitHubPort({ listPullRequestsForBranch: async () => null }, createCalls),
		});
		assert.equal(created.success, true);
		assert.equal(created.prNumber, 123);
		assert.ok(createCalls.some((call) => call.method === "createPullRequest"));

		const updateCalls: PortCall[] = [];
		const updated = await upsertPullRequest({
			...base,
			port: createMockGitHubPort(
				{
					listPullRequestsForBranch: async () => ({
						number: 42,
						hasConflict: false,
						mergeable: "MERGEABLE",
						mergeStateStatus: "CLEAN",
						headRefName: "goal/x",
						baseRefName: "main",
					}),
				},
				updateCalls,
			),
		});
		assert.equal(updated.success, true);
		assert.equal(updated.wasUpdate, true);
		assert.equal(updated.prNumber, 42);
		assert.deepEqual(
			updateCalls.map((call) => call.method),
			["listPullRequestsForBranch", "updatePullRequest"],
		);
	});

	it("fails closed without a port", async () => {
		const result = await upsertPullRequest({ ...base });
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /Port not available|GitHubPort not available/);
	});

	it("reports a create failure with the API message", async () => {
		const port = createMockGitHubPort({
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => {
				throw new Error("422 Validation Failed");
			},
		});
		const result = await upsertPullRequest({ ...base, port, sleep: async () => {} });
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /422 Validation Failed/);
	});

	it("updatePullRequestBody is the update-only path", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				listPullRequestsForBranch: async () => ({
					number: 9,
					hasConflict: false,
					mergeable: "MERGEABLE",
					mergeStateStatus: "CLEAN",
					headRefName: "goal/x",
					baseRefName: "main",
				}),
			},
			calls,
		);
		const result = await updatePullRequestBody({
			repo: "owner/repo",
			head: "goal/x",
			title: "t",
			body: "b",
			port,
		});
		assert.equal(result.success, true);
		assert.equal(result.wasUpdate, true);
		assert.equal(
			calls.some((call) => call.method === "createPullRequest"),
			false,
		);
	});

	it("is what Supervisor's pr-creation resolves through", () => {
		const source = readFileSync(`${ROOT}/supervisor/pipeline/pr-creation.ts`, "utf-8");
		assert.match(source, /shared\/github\/pull-request\.ts/);
		assert.match(source, /await sharedUpsertPullRequest\(/);
		assert.match(source, /await sharedUpdatePullRequestBody\(/);
	});
});

describe("shared/model/model-ref.ts resolveModel", () => {
	it("returns the same catalog entry as getBuiltinModel", () => {
		const resolved = resolveModel("openai/gpt-4o");
		const direct = getBuiltinModel("openai" as never, "gpt-4o" as never);
		assert.deepEqual(resolved, direct);
		assert.equal(resolved.id, "gpt-4o");
		assert.equal(resolved.provider, "openai");
	});

	it("keeps the original message for a missing model string", () => {
		assert.throws(
			() => resolveModel(undefined),
			/Agent has no model configured \(config\.model = "undefined"\)/,
		);
		assert.throws(() => resolveModel(""), /Agent has no model configured \(config\.model = ""\)/);
	});

	it("keeps the original message for a malformed ref", () => {
		assert.throws(
			() => resolveModel("no-slash"),
			/Invalid model format "no-slash" — expected "provider\/model-id"/,
		);
	});

	it("keeps the original message for an unresolvable ref", () => {
		// `getBuiltinModel` returns undefined (it does not throw) for an unknown
		// ref; the shared resolver fails there with the historical message prefix
		// instead of letting a later property access throw a TypeError.
		assert.throws(() => resolveModel("nope/nope"), /Model "nope\/nope" could not be resolved: /);
	});

	it("splits only the first segment as the provider", () => {
		assert.deepEqual(parseModelRef("openrouter/meta/llama"), {
			ref: "openrouter/meta/llama",
			provider: "openrouter",
			modelId: "meta/llama",
		});
	});

	it("leaves no duplicate definition in the Supervisor runner", () => {
		const source = readFileSync(`${ROOT}/supervisor/agent/agent-session-runner.ts`, "utf-8");
		const localDefinitions = source
			.split("\n")
			.filter((line) => /^\s*(export\s+)?function resolveModel\b/.test(line));
		assert.equal(localDefinitions.length, 0, "no local resolveModel definition remains");
		assert.match(source, /from "\.\.\/\.\.\/shared\/model\/model-ref\.ts"/);
	});
});
