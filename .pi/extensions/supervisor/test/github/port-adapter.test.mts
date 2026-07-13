// ─── Tests: github/gh-client.ts — createGitHubPort adapter ───────
// Tests the 8-method port adapter with mock exec. No network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../pipeline/helpers.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { createGitHubPort } from "../../github/gh-client.ts";
import type { ProjectField, ProjectItem, DepsResult, PrConflictInfo } from "../../config/types.ts";

// ─── Mock exec ───────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
}

function createMockExec(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExecFn {
	const callLog = calls || [];
	let idx = 0;
	return async (cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> => {
		callLog.push({ cmd, args: args || [] });
		const result = results[idx++];
		if (!result || result.code !== 0) {
			return {
				code: result?.code ?? 1,
				stdout: result?.stdout ?? "",
				stderr: result?.stderr ?? `Command failed: ${cmd}`,
				killed: false,
			};
		}
		return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe("createGitHubPort() — gh CLI adapter", () => {
	it("createGitHubPort is a function", () => {
		assert.equal(typeof createGitHubPort, "function");
	});

	it("returns object with all 8 methods", () => {
		const exec = createMockExec([]);
		const port = createGitHubPort(exec);
		assert.equal(typeof port.postIssueComment, "function");
		assert.equal(typeof port.getProjectFields, "function");
		assert.equal(typeof port.getProjectItems, "function");
		assert.equal(typeof port.getProjectId, "function");
		assert.equal(typeof port.setItemStatusField, "function");
		assert.equal(typeof port.checkBlockedByDependencies, "function");
		assert.equal(typeof port.createPullRequest, "function");
		assert.equal(typeof port.listPullRequestsForBranch, "function");
	});

	it("getProjectFields calls ghGraphQL and maps response", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[
				{
					code: 0,
					stdout: JSON.stringify({
						data: {
							viewer: {
								projectV2: {
									fields: {
										nodes: [
											{ id: "f1", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "Done" }] },
											{ id: "f2", name: "Priority", dataType: "TEXT" },
										],
									},
								},
							},
						},
					}),
					stderr: "",
				},
			],
			calls,
		);
		const port = createGitHubPort(exec);
		const fields = await port.getProjectFields(1);
		assert.equal(fields.length, 2);
		assert.equal(fields[0].name, "Status");
		assert.equal(fields[0].type, "SINGLE_SELECT");
		assert.deepEqual(fields[0].options, [{ id: "o1", name: "Done" }]);
		assert.equal(fields[1].name, "Priority");
	});

	it("getProjectItems returns empty array for null response", async () => {
		const exec = createMockExec([{ code: 0, stdout: JSON.stringify({ data: { viewer: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }), stderr: "" }]);
		const port = createGitHubPort(exec);
		const items = await port.getProjectItems(1);
		assert.deepEqual(items, []);
	});

	it("getProjectId returns empty string for null response", async () => {
		const exec = createMockExec([{ code: 0, stdout: JSON.stringify({ data: { viewer: { projectV2: null } } }), stderr: "" }]);
		const port = createGitHubPort(exec);
		const id = await port.getProjectId(1);
		assert.equal(id, "");
	});

	it("setItemStatusField calls gh project item-edit", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: "", stderr: "" }], calls);
		const port = createGitHubPort(exec);
		await port.setItemStatusField("item_1", "proj_1", "field_1", "opt_1");
		const ghCall = calls.find((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCall, "should call gh");
	});

	it("checkBlockedByDependencies returns {blocked: false} for empty timeline", async () => {
		const exec = createMockExec([
			{
				code: 0,
				stdout: JSON.stringify({
					data: { repository: { issue: { timelineItems: { nodes: [] } } } },
				}),
				stderr: "",
			},
		]);
		const port = createGitHubPort(exec);
		const result = await port.checkBlockedByDependencies(1, "owner/repo");
		assert.deepEqual(result, { blocked: false, blockers: [] });
	});

	it("checkBlockedByDependencies throws on invalid repo format", async () => {
		const exec = createMockExec([]);
		const port = createGitHubPort(exec);
		await assert.rejects(
			() => port.checkBlockedByDependencies(1, "invalid"),
			/Invalid repo format/,
		);
	});

	it("listPullRequestsForBranch returns null when no PR found", async () => {
		const exec = createMockExec([{ code: 0, stdout: "[]", stderr: "" }]);
		const port = createGitHubPort(exec);
		const result = await port.listPullRequestsForBranch("branch", "owner/repo");
		assert.equal(result, null);
	});

	it("listPullRequestsForBranch returns PrConflictInfo when PR exists", async () => {
		const prData = [{
			number: 123,
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			headRefName: "branch",
			baseRefName: "main",
		}];
		const exec = createMockExec([{ code: 0, stdout: JSON.stringify(prData), stderr: "" }]);
		const port = createGitHubPort(exec);
		const result = await port.listPullRequestsForBranch("branch", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.number, 123);
		assert.equal(result.hasConflict, false);
	});

	it("listPullRequestsForBranch detects conflict", async () => {
		const prData = [{
			number: 123,
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			headRefName: "branch",
			baseRefName: "main",
		}];
		const exec = createMockExec([{ code: 0, stdout: JSON.stringify(prData), stderr: "" }]);
		const port = createGitHubPort(exec);
		const result = await port.listPullRequestsForBranch("branch", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.hasConflict, true);
	});

	it("createPullRequest parses PR number from URL", async () => {
		const exec = createMockExec([{ code: 0, stdout: "https://github.com/owner/repo/pull/456", stderr: "" }]);
		const port = createGitHubPort(exec);
		const result = await port.createPullRequest({
			repo: "owner/repo",
			base: "main",
			head: "feature",
			title: "Test PR",
		});
		assert.deepEqual(result, { number: 456 });
	});

	it("createPullRequest throws on unparseable output", async () => {
		const exec = createMockExec([{ code: 0, stdout: "unexpected output", stderr: "" }]);
		const port = createGitHubPort(exec);
		await assert.rejects(
			() => port.createPullRequest({ repo: "o/r", base: "main", head: "f", title: "t" }),
			/gh pr create failed/,
		);
	});

	it("postIssueComment writes temp file and calls gh issue comment", async () => {
		const calls: ExecCall[] = [];
		// Need a successful gh call
		const exec = createMockExec([{ code: 0, stdout: "", stderr: "" }], calls);
		const port = createGitHubPort(exec);
		await port.postIssueComment(42, "owner/repo", "Test comment body");
		// Should have called gh via bash or gh directly
		const ghCall = calls.find((c) => {
			const args = c.cmd === "bash" ? c.args.slice(3) : c.args;
			return args.includes("issue") && args.includes("comment");
		});
		assert.ok(ghCall, "should call gh issue comment");
	});
});
