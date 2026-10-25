import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";

import {
	buildAgentResultEntry,
	type StageState,
	type AuditGateContext,
	type GateRejected,
	handleBacklogTransition,
	applyStatusTransition,
} from "../../pipeline/stages/index.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
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

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: {
				fg: (_style: string, text: string) => text,
			},
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

function makeProjectFields(statusFieldId: string): ProjectField[] {
	return [
		{
			id: statusFieldId,
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt_bk", name: "Backlog" },
				{ id: "opt_re", name: "Research" },
				{ id: "opt_ar", name: "Architecture" },
				{ id: "opt_td", name: "TestDesign" },
				{ id: "opt_im", name: "Implementation" },
				{ id: "opt_au", name: "Audit" },
				{ id: "opt_dn", name: "Done" },
			],
		},
	];
}

function wrapJsonOutput(obj: Record<string, unknown>): string {
	return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

describe("buildAgentResultEntry()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "developer",
		toolCount: 10,
		tokenCount: 5000,
		durationMs: 30000,
		textOutput: "done",
		summaryLine: "Implemented feature",
		errorOutput: "",
		textOnly: "IMPLEMENTATION_COMPLETE",
	};

	it("maps success=true to 'SUCCESS'", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.status, "SUCCESS");
	});

	it("maps success=true + usedRetry=true to 'SUCCESS (after retry)'", () => {
		const entry = buildAgentResultEntry(baseResult, true);
		assert.equal(entry.status, "SUCCESS (after retry)");
	});

	it("maps success=false to 'FAILED'", () => {
		const entry = buildAgentResultEntry({ ...baseResult, success: false }, false);
		assert.equal(entry.status, "FAILED");
	});

	it("maps success=false + usedRetry=true to 'FAILED' (retry-also-fails row must not show retry label)", () => {
		const entry = buildAgentResultEntry({ ...baseResult, success: false }, true);
		assert.equal(entry.status, "FAILED");
	});

	it("maps success=false + timedOut=true to 'FAILED' while preserving timeout metadata", () => {
		const entry = buildAgentResultEntry(
			{ ...baseResult, success: false, timedOut: true, configuredTimeoutMs: 60_000 },
			false,
		);
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.timedOut, true);
		assert.equal(entry.configuredTimeoutMs, 60_000);
	});

	it("copies durationMs/tokenCount/toolCount/agentName from result", () => {
		const entry = buildAgentResultEntry(
			{
				...baseResult,
				success: true,
				agentName: "auditor",
				durationMs: 15000,
				tokenCount: 3000,
				toolCount: 5,
			},
			false,
		);
		assert.equal(entry.agentName, "auditor");
		assert.equal(entry.durationMs, 15000);
		assert.equal(entry.tokenCount, 3000);
		assert.equal(entry.toolCount, 5);
	});

	it("model is undefined when not provided", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.model, undefined);
	});

	it("model is set when provided", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		assert.equal(entry.model, "anthropic/claude-sonnet-4-20250514");
	});

	it("model shows as short name in pipeline output", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "claude-sonnet-4-20250514");
	});

	it("threads errorOutput from AgentRunResult when provided", () => {
		const entry = buildAgentResultEntry(
			{ ...baseResult, success: false, errorOutput: "Failed to start: ENOENT" },
			false,
		);
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.errorOutput, "Failed to start: ENOENT");
	});

	it("errorOutput is undefined when AgentRunResult has empty errorOutput", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.errorOutput, undefined);
	});

	it("model is undefined when not provided, shows dash in output", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "—");
	});

	it("threads failedToolCount from result", () => {
		const entry = buildAgentResultEntry({ ...baseResult, failedToolCount: 2 }, false);
		assert.equal(entry.failedToolCount, 2);
	});

	it("folds nestedErrors into failedToolCount via the shared combine", () => {
		const entry = buildAgentResultEntry(
			{ ...baseResult, failedToolCount: 1, nestedErrors: 2 },
			false,
		);
		assert.equal(entry.failedToolCount, 3);
	});

	it("nestedErrors only → failedToolCount equals nestedErrors", () => {
		const entry = buildAgentResultEntry({ ...baseResult, nestedErrors: 2 }, false);
		assert.equal(entry.failedToolCount, 2);
	});

	it("failedToolCount is undefined when not present on result", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.failedToolCount, undefined);
	});

	it("existing fields unchanged when failedToolCount absent (regression guard)", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.status, "SUCCESS");
		assert.equal(entry.agentName, "developer");
		assert.equal(entry.toolCount, 10);
		assert.equal(entry.tokenCount, 5000);
		assert.equal(entry.durationMs, 30000);
		assert.equal(entry.model, undefined);
	});

	// ── Per-agent wall-clock timeout (issue #1710) ──────────────────

	it("timeout result → FAILED entry carrying timedOut/configuredTimeoutMs + [Timeout] note", () => {
		const entry = buildAgentResultEntry(
			{
				...baseResult,
				success: false,
				timedOut: true,
				configuredTimeoutMs: 60_000,
				killReason: "timeout",
				errorOutput: "[Timeout: developer exceeded 60s (actual 61000ms)]",
			},
			false,
		);
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.timedOut, true, "timedOut flows onto PipelineAgentResult");
		assert.equal(entry.configuredTimeoutMs, 60_000, "configured duration recorded");
		assert.equal(
			entry.errorOutput,
			"[Timeout: developer exceeded 60s (actual 61000ms)]",
			"timeout failure note retained in pipeline state",
		);
	});

	it("non-timeout result → timedOut/configuredTimeoutMs absent (regression)", () => {
		const entry = buildAgentResultEntry(
			{ ...baseResult, success: false, errorOutput: "stderr only" },
			false,
		);
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.timedOut, undefined);
		assert.equal(entry.configuredTimeoutMs, undefined);
		assert.equal(entry.errorOutput, "stderr only", "non-timeout entry unchanged");
	});
});
describe("handleBacklogTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls port.setItemStatusField with correct args and returns 'Research' on success", async () => {
		const trackCalls: PortCall[] = [];
		const fields = makeProjectFields(statusFieldId);

		const result = await handleBacklogTransition(
			createMockGitHubPort({}, trackCalls),
			fields,
			statusFieldId,
			"item_123",
			"project_456",
		);
		assert.equal(result, "Research");

		// Verify port.setItemStatusField was called with correct args
		assert.equal(trackCalls.length, 1);
		assert.equal(trackCalls[0].method, "setItemStatusField");
		assert.deepStrictEqual(trackCalls[0].args, [
			"item_123",
			"project_456",
			statusFieldId,
			"opt_re",
		]);
	});

	it("throws when 'Research' option not found", async () => {
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [
					{ id: "opt_bk", name: "Backlog" },
					{ id: "opt_ar", name: "Architecture" },
				],
			},
		];

		await assert.rejects(
			() =>
				handleBacklogTransition(
					createMockGitHubPort(),
					fields,
					statusFieldId,
					"item_123",
					"project_456",
				),
			/Cannot find 'Research' status option/,
		);
	});

	it("throws when port.setItemStatusField fails", async () => {
		const fields = makeProjectFields(statusFieldId);
		const mockPort = createMockGitHubPort({
			setItemStatusField: async () => {
				throw new Error("network error");
			},
		});

		await assert.rejects(
			() => handleBacklogTransition(mockPort, fields, statusFieldId, "item_123", "project_456"),
			/Failed to set status/,
		);
	});
});
describe("applyStatusTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls port.setItemStatusField with correct option id and returns targetStatus", async () => {
		const trackCalls: PortCall[] = [];
		const fields = makeProjectFields(statusFieldId);

		const result = await applyStatusTransition(
			createMockGitHubPort({}, trackCalls),
			"item_123",
			"project_456",
			fields,
			statusFieldId,
			"Audit",
		);
		assert.equal(result, "Audit");

		assert.equal(trackCalls.length, 1);
		assert.equal(trackCalls[0].method, "setItemStatusField");
		assert.deepStrictEqual(trackCalls[0].args, [
			"item_123",
			"project_456",
			statusFieldId,
			"opt_au",
		]);
	});

	it("throws when option not found", async () => {
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [{ id: "opt_bk", name: "Backlog" }],
			},
		];

		await assert.rejects(
			() =>
				applyStatusTransition(
					createMockGitHubPort(),
					"item_123",
					"project_456",
					fields,
					statusFieldId,
					"Audit",
				),
			/Cannot find 'Audit' option on board/,
		);
	});
});
