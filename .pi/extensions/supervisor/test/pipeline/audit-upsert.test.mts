// ─── Tests: audit rejection upsert (issue #2044) ─────────────────
// The auditor updates its prior rejection comment in place instead of
// appending a new one, and bumps the `reject-N` label that now carries the
// loop counter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import type { SupervisorConfig, AgentRunResult, FilteredIssueData } from "../../config/types.ts";
import { handlePostAgentSuccess } from "../../pipeline/stages/index.ts";

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
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

function createMockPi(): ExtensionAPI {
	return {
		exec: (async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_s: string, t: string) => t } },
	} as unknown as ExtensionCommandContext;
}

function auditorResult(commentBody: string): AgentRunResult {
	const json = JSON.stringify({
		action: "REJECTED",
		agentName: "auditor",
		summary: "issues",
		commentBody,
		findings: [{ severity: "critical", dimension: "code-quality", symptom: "x" }],
	});
	return {
		output: json,
		success: true,
		agentName: "auditor",
		toolCount: 1,
		tokenCount: 10,
		durationMs: 5,
		textOutput: json,
		summaryLine: "issues",
		errorOutput: "",
		textOnly: json,
	};
}

async function run(port: ReturnType<typeof createMockGitHubPort>, data: FilteredIssueData) {
	return handlePostAgentSuccess(
		createMockPi(),
		createMockCtx(),
		auditorResult("## Audit Rejected\n\nstill broken"),
		"auditor",
		42,
		mockConfig,
		data,
		undefined,
		undefined,
		"Test issue",
		undefined,
		undefined,
		undefined,
		port,
	);
}

const MARK = "<!-- supervisor:audit-rejection -->";

describe("audit rejection upsert (issue #2044)", () => {
	it("posts a new rejection (with marker) and label when no prior rejection exists", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		await run(port, { body: "", comments: [] });

		const post = calls.find((c) => c.method === "postIssueComment");
		assert.ok(post, "posts the first rejection");
		assert.ok(
			String(post!.args[2]).includes(MARK),
			"new rejection carries the supervisor marker",
		);
		assert.equal(calls.find((c) => c.method === "updateIssueComment"), undefined);

		const add = calls.find((c) => c.method === "addIssueLabel");
		assert.ok(add, "bumps the reject label");
		assert.equal(add!.args[2], "reject-1");
	});

	it("updates the supervisor's prior rejection in place instead of appending", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const data: FilteredIssueData = {
			body: "",
			comments: [{ author: "user1", body: "fix pushed" }],
			auditRejections: [{ id: "IC_old", body: `## Audit Rejected\n\nold\n\n${MARK}` }],
		};
		await run(port, data);

		const update = calls.find((c) => c.method === "updateIssueComment");
		assert.ok(update, "updates the prior rejection");
		assert.equal(update!.args[0], "IC_old");
		assert.equal(calls.find((c) => c.method === "postIssueComment"), undefined);
	});

	it("updates the prior rejection even when it is not in the trusted comments", async () => {
		// Automation account not a codeowner: the rejection is absent from
		// `comments` but present in `auditRejections` (issue #2044 audit finding #1).
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const data: FilteredIssueData = {
			body: "",
			comments: [{ author: "user1", body: "unrelated" }],
			auditRejections: [{ id: "IC_bot", body: `## Audit Rejected\n\nold\n\n${MARK}` }],
		};
		await run(port, data);

		const update = calls.find((c) => c.method === "updateIssueComment");
		assert.ok(update, "updates the untrusted-but-supervisor rejection");
		assert.equal(update!.args[0], "IC_bot");
	});

	it("updates a pre-marker (unmarked) prior rejection in place", async () => {
		// Upgrade path (issue #2044 audit finding): issues rejected before the
		// marker existed still carry an automation-authored rejection comment that
		// must be re-verified and updated, not duplicated.
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const data: FilteredIssueData = {
			body: "",
			comments: [],
			auditRejections: [{ id: "IC_legacy", body: "## Audit Rejected\n\nold" }],
		};
		await run(port, data);

		const update = calls.find((c) => c.method === "updateIssueComment");
		assert.ok(update, "updates the pre-marker rejection");
		assert.equal(update!.args[0], "IC_legacy");
		assert.equal(calls.find((c) => c.method === "postIssueComment"), undefined);
	});

	it("bumps reject-N from the existing label, removing the previous one", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ getIssueLabels: async () => ["reject-4"] }, calls);
		await run(port, { body: "", comments: [] });

		const add = calls.find((c) => c.method === "addIssueLabel");
		assert.deepEqual(add!.args[2], "reject-5");
		const remove = calls.find((c) => c.method === "removeIssueLabel");
		assert.equal(remove!.args[2], "reject-4");
	});

	it("falls back to the legacy comment count on the first bump", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const data: FilteredIssueData = { body: "", comments: [], rejectionCommentCount: 2 };
		await run(port, data);

		const add = calls.find((c) => c.method === "addIssueLabel");
		assert.equal(add!.args[2], "reject-3", "max(labels, raw rejection count) + 1");
	});

	it("fails closed when reading the reject labels fails (audit finding #2)", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				getIssueLabels: async () => {
					throw new Error("503 Service Unavailable");
				},
			},
			calls,
		);
		await assert.rejects(() => run(port, { body: "", comments: [] }), /Failed to read reject labels/);
		assert.equal(
			calls.find((c) => c.method === "addIssueLabel"),
			undefined,
			"must not advance a counter it could not read",
		);
	});

	it("fails closed when adding the reject label fails (audit finding #2)", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				addIssueLabel: async () => {
					throw new Error("403 Forbidden");
				},
			},
			calls,
		);
		await assert.rejects(
			() => run(port, { body: "", comments: [] }),
			/Failed to record reject label/,
		);
	});

	it("does not block the transition when removing the stale label fails", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				getIssueLabels: async () => ["reject-1"],
				removeIssueLabel: async () => {
					throw new Error("boom");
				},
			},
			calls,
		);
		await run(port, { body: "", comments: [] });
		const add = calls.find((c) => c.method === "addIssueLabel");
		assert.equal(add!.args[2], "reject-2");
	});

	it("fails closed when the comment write fails: no label bump, error surfaced (audit finding #2)", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				postIssueComment: async () => {
					throw new Error("403 Forbidden");
				},
			},
			calls,
		);
		await assert.rejects(() => run(port, { body: "", comments: [] }), /Failed to post audit rejection/);

		assert.ok(calls.find((c) => c.method === "postIssueComment"), "attempts the write");
		assert.equal(
			calls.find((c) => c.method === "addIssueLabel"),
			undefined,
			"label must not advance when the rejection was not persisted",
		);
	});

	it("does NOT overwrite an unmarked codeowner comment with a rejection heading", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({}, calls);
		const data: FilteredIssueData = {
			body: "",
			comments: [{ author: "user1", body: "## Audit Rejected\nmanual note", id: "IC_manual" }],
		};
		await run(port, data);

		assert.equal(
			calls.find((c) => c.method === "updateIssueComment"),
			undefined,
			"an unmarked comment is never updated in place",
		);
		assert.ok(calls.find((c) => c.method === "postIssueComment"), "posts a new marked rejection");
	});
});
