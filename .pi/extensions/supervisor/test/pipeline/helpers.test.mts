// ─── Tests: pipeline/helpers.ts — injected-dependency helpers ───
// Tests with mock GitHubPort/NotifyFn. No real gh/git operations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubPort } from "../../test/helper/mock-github-port.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { ProjectField, PrConflictInfo, DepsResult } from "../../config/types.ts";
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
		const port = createMockGitHubPort({
			getIssue: async () => ({
				number: 42,
				title: "Test",
				body: "body",
				author: { login: "user1" },
				comments: [],
			}),
		});
		const notify = makeNotify();

		const result = await fetchIssue(port, notify, mockConfig, 42);
		assert.ok(result);
		assert.equal(result!.number, 42);
		assert.equal((result as Record<string, unknown>).title as string, "Test");
	});

	it("returns null and notifies error when issue not found", async () => {
		const port = createMockGitHubPort({
			getIssue: async () => null,
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await fetchIssue(port, notify, mockConfig, 999);
		assert.equal(result, null);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("999")));
	});

	it("returns null and notifies error when port throws", async () => {
		const port = createMockGitHubPort({
			getIssue: async () => {
				throw new Error("network error");
			},
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await fetchIssue(port, notify, mockConfig, 42);
		assert.equal(result, null);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: readProjectBoard() ────────────────────────────────────

describe("readProjectBoard()", () => {
	const statusField: ProjectField = {
		id: "sf_1",
		name: "Status",
		type: "SINGLE_SELECT",
		options: [{ id: "opt_ar", name: "Architecture" }],
	};

	it("reads project fields, items, and returns statusField", async () => {
		const port = createMockGitHubPort({
			getProjectFields: async () => [statusField],
			getProjectItems: async () => [],
			getProjectId: async () => "project_123",
		});
		const notify = makeNotify();

		const result = await readProjectBoard(port, notify, mockConfig, 42);
		assert.ok(result.fields, "fields should be returned");
		assert.ok(Array.isArray(result.items), "items should be an array");
		assert.equal(result.projectId, "project_123");
		assert.ok(result.statusField, "statusField should be found");
		assert.equal(result.statusField!.name, "Status");
	});

	it("returns null fields when statusField not found", async () => {
		const port = createMockGitHubPort({
			getProjectFields: async () => [{
				id: "sf_1",
				name: "Priority",
				type: "SINGLE_SELECT",
				options: [],
			}],
			getProjectItems: async () => [],
			getProjectId: async () => "project_123",
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await readProjectBoard(port, notify, mockConfig, 42);
		assert.equal(result.fields, null);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("Status")));
	});

	it("handles port errors gracefully", async () => {
		const port = createMockGitHubPort({
			getProjectFields: async () => {
				throw new Error("network error");
			},
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await readProjectBoard(port, notify, mockConfig, 42);
		assert.equal(result.fields, null);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: checkDependencies() ───────────────────────────────────

describe("checkDependencies()", () => {
	it("returns true when no blockers found", async () => {
		const port = createMockGitHubPort({
			checkBlockedByDependencies: async () => ({
				blocked: false,
				blockers: [],
			}),
		});
		const notify = makeNotify();

		const result = await checkDependencies(port, notify, mockConfig, 42);
		assert.equal(result, true);
	});

	it("returns false and notifies when blockers exist", async () => {
		const port = createMockGitHubPort({
			checkBlockedByDependencies: async () => ({
				blocked: true,
				blockers: [{
					number: 100,
					title: "Blocker",
					type: "issue" as const,
					state: "OPEN",
				}],
			}),
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await checkDependencies(port, notify, mockConfig, 42);
		assert.equal(result, false);
		assert.ok(notifyLog.some((n) => n.level === "error" && n.msg.includes("blocked")));
	});

	it("returns false on port error", async () => {
		const port = createMockGitHubPort({
			checkBlockedByDependencies: async () => {
				throw new Error("network error");
			},
		});
		const notifyLog: Array<{ level: string; msg: string }> = [];
		const notify = makeNotify(notifyLog);

		const result = await checkDependencies(port, notify, mockConfig, 42);
		assert.equal(result, false);
		assert.ok(notifyLog.some((n) => n.level === "error"));
	});
});

// ─── Tests: fetchFreshIssueData() ─────────────────────────────────

describe("fetchFreshIssueData()", () => {
	it("fetches fresh data and filters by codeowners", async () => {
		const port = createMockGitHubPort({
			getIssueWithComments: async () => ({
				number: 42,
				title: "Test",
				body: "issue body",
				author: { login: "user1" },
				comments: [
					{ author: { login: "user1" }, body: "comment" },
					{ author: { login: "untrusted" }, body: "malicious" },
				],
			}),
		});

		const result = await fetchFreshIssueData(port, mockConfig, 42, {});
		assert.equal(result.body, "issue body");
		// Only trusted user's comment should pass through
		assert.equal(result.comments.length, 1);
		assert.equal(result.comments[0].author, "user1");
	});

	it("falls back to fallbackData on error", async () => {
		const port = createMockGitHubPort({
			getIssueWithComments: async () => {
				throw new Error("network error");
			},
		});
		const fallback = {
			number: 42,
			title: "Fallback",
			body: "fallback body",
			author: { login: "user1" },
			comments: [{ author: { login: "user1" }, body: "comment" }],
		};

		const result = await fetchFreshIssueData(port, mockConfig, 42, fallback);
		assert.equal(result.body, "fallback body");
	});
});

// ─── Tests: loadAgentFile() ───────────────────────────────────────

describe("loadAgentFile()", () => {
	it("loads and parses agent file when it exists", async () => {
		const exec: ExecFn = async (cmd: string) => {
			if (cmd === "test") return { code: 0, stdout: "", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		const notify = makeNotify();

		const result = await loadAgentFile(exec, notify, "/repo", "developer");
		assert.ok(result !== null, "should return parsed agent when file exists");
		assert.equal(result!.config.name, "developer");
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
