// ─── Tests: pipeline/helpers.ts — injected-dependency helpers ───
// Tests with mock ExecFn/NotifyFn. No real gh/git operations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import {
	fetchIssue,
	readProjectBoard,
	checkDependencies,
	fetchFreshIssueData,
	loadAgentFile,
	type NotifyFn,
	type ExecFn,
} from "../../pipeline/helpers.ts";

// ─── Mock Helpers ──────────────────────────────────────────────────

function makeExec(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
): ExecFn {
	const callLog = calls || [];
	let idx = 0;
	return async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
		callLog.push({ cmd, args: args || [], opts: (opts || {}) as Record<string, unknown> });
		const result = results[idx++];
		if (!result) {
			return { code: 0, stdout: "", stderr: "", killed: false };
		}
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || `Command failed: ${cmd}`);
		}
		return { ...result, killed: false };
	};
}

function makeNotify(calls?: Array<{ level: string; msg: string }>): NotifyFn {
	const log = calls || [];
	return {
		info: (msg: string) => {
			log.push({ level: "info", msg });
		},
		error: (msg: string) => {
			log.push({ level: "error", msg });
		},
	};
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

// ─── Tests: fetchIssue() ──────────────────────────────────────────

describe("fetchIssue()", () => {
	it("fetches and parses issue data from GitHub", async () => {
		const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const exec = makeExec(
			[
				{
					code: 0,
					stdout: JSON.stringify({
						number: 42,
						title: "Test",
						body: "body",
						author: { login: "user1" },
						comments: [],
					}),
					stderr: "",
				},
			],
			calls,
		);
		const notify = makeNotify();

		const result = await fetchIssue(exec, notify, mockConfig, 42);
		assert.ok(result);
		assert.equal(result!.number, 42);
		assert.equal(result!.title, "Test");

		// Verify exec was called with correct gh command
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "gh");
		assert.ok(calls[0].args.includes("42"));
		assert.ok(calls[0].args.includes("--repo"));
		assert.ok(calls[0].args.includes("owner/repo"));
	});

	it("returns null and notifies error when gh fails", async () => {
		const exec = makeExec([{ code: 1, stdout: "", stderr: "Not Found" }]);
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await fetchIssue(exec, notify, mockConfig, 999);
		assert.equal(result, null);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("999")));
	});

	it("returns null and notifies error when exec throws", async () => {
		const exec: ExecFn = async () => {
			throw new Error("network error");
		};
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await fetchIssue(exec, notify, mockConfig, 42);
		assert.equal(result, null);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: readProjectBoard() ────────────────────────────────────

describe("readProjectBoard()", () => {
	it("reads project fields, items, and returns statusField", async () => {
		const exec = makeExec([
			// getProjectFields: gh graphql query
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								fields: {
									nodes: [
										{
											id: "sf_1",
											name: "Status",
											dataType: "SINGLE_SELECT",
											options: [{ id: "opt_ar", name: "Architecture" }],
										},
									],
								},
							},
						},
					},
				}),
				stderr: "",
			},
			// getProjectItems: gh graphql query
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								items: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [],
								},
							},
						},
					},
				}),
				stderr: "",
			},
			// getProjectId: gh graphql query
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								id: "project_123",
							},
						},
					},
				}),
				stderr: "",
			},
		]);
		const notify = makeNotify();

		const result = await readProjectBoard(exec, notify, mockConfig, 42);
		assert.ok(result.fields, "fields should be returned");
		assert.ok(Array.isArray(result.items), "items should be an array");
		assert.equal(result.projectId, "project_123");
		assert.ok(result.statusField, "statusField should be found");
		assert.equal(result.statusField!.name, "Status");
	});

	it("returns null fields when statusField not found", async () => {
		const exec = makeExec([
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								fields: {
									nodes: [{ id: "sf_1", name: "Priority", dataType: "SINGLE_SELECT", options: [] }],
								},
							},
						},
					},
				}),
				stderr: "",
			},
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								items: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [],
								},
							},
						},
					},
				}),
				stderr: "",
			},
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: {
							projectV2: {
								id: "project_123",
							},
						},
					},
				}),
				stderr: "",
			},
		]);
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await readProjectBoard(exec, notify, mockConfig, 42);
		assert.equal(result.fields, null);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("Status")));
	});

	it("handles exec errors gracefully", async () => {
		const exec: ExecFn = async () => {
			throw new Error("network error");
		};
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await readProjectBoard(exec, notify, mockConfig, 42);
		assert.equal(result.fields, null);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: checkDependencies() ───────────────────────────────────

describe("checkDependencies()", () => {
	it("returns true when no blockers found", async () => {
		const exec = makeExec([
			{
				code: 0,
				stdout: JSON.stringify({
					data: { repository: { issue: { timelineItems: { nodes: [] } } } },
				}),
				stderr: "",
			},
		]);
		const notify = makeNotify();

		const result = await checkDependencies(exec, notify, mockConfig, 42);
		assert.equal(result, true);
	});

	it("returns false and notifies when blockers exist", async () => {
		const exec = makeExec([
			{
				code: 0,
				stdout: JSON.stringify({
					data: {
						repository: {
							issue: {
								timelineItems: {
									nodes: [
										{
											__typename: "BlockedByAddedEvent",
											blockingIssue: { id: "1", number: 100, title: "Blocker", state: "OPEN" },
										},
									],
								},
							},
						},
					},
				}),
				stderr: "",
			},
		]);
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await checkDependencies(exec, notify, mockConfig, 42);
		assert.equal(result, false);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("blocked")));
	});

	it("returns false on exec error", async () => {
		const exec: ExecFn = async () => {
			throw new Error("network error");
		};
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await checkDependencies(exec, notify, mockConfig, 42);
		assert.equal(result, false);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: fetchFreshIssueData() ─────────────────────────────────

describe("fetchFreshIssueData()", () => {
	it("fetches fresh data and filters by codeowners", async () => {
		const exec = makeExec([
			{
				code: 0,
				stdout: JSON.stringify({
					number: 42,
					title: "Test",
					body: "issue body",
					author: { login: "user1" },
					comments: [
						{ author: { login: "user1" }, body: "comment" },
						{ author: { login: "untrusted" }, body: "malicious" },
					],
				}),
				stderr: "",
			},
		]);

		const result = await fetchFreshIssueData(exec, mockConfig, 42, {});
		assert.equal(result.body, "issue body");
		// Only trusted user's comment should pass through
		assert.equal(result.comments.length, 1);
		assert.equal(result.comments[0].author, "user1");
	});

	it("falls back to fallbackData on error", async () => {
		const exec: ExecFn = async () => {
			throw new Error("network error");
		};
		const fallback = {
			number: 42,
			title: "Fallback",
			body: "fallback body",
			author: { login: "user1" },
			comments: [{ author: { login: "user1" }, body: "comment" }],
		};

		const result = await fetchFreshIssueData(exec, mockConfig, 42, fallback);
		assert.equal(result.body, "fallback body");
	});
});

// ─── Tests: loadAgentFile() ───────────────────────────────────────

describe("loadAgentFile()", () => {
	it("loads and parses agent file when it exists", async () => {
		const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
		const exec = makeExec(
			[
				{ code: 0, stdout: "", stderr: "" }, // test -f succeeds
			],
			calls,
		);
		const notify = makeNotify();

		const result = await loadAgentFile(exec, notify, "/repo", "developer");
		// The developer agent file exists on disk, so parseAgentFile succeeds
		assert.ok(result !== null, "should return parsed agent when file exists");
		assert.equal(result!.config.name, "developer");
		// Verify exec was called with test -f
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "test");
		assert.ok(calls[0].args.includes("-f"));
		assert.ok(calls[0].args[1].includes("developer"));
	});

	it("returns null when agent file does not exist", async () => {
		const exec: ExecFn = async () => {
			throw new Error("File not found");
		};
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await loadAgentFile(exec, notify, "/repo", "nonexistent");
		assert.equal(result, null);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("nonexistent")));
	});
});
