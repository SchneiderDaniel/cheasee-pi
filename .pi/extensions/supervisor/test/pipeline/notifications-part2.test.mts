// ─── Tests: pipeline/notifications.ts — sendPipelineSummary, sendPipelineError ───
// Tests for pipeline notification functions with prCreationResult handling.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	PrCreationResult,
} from "../../config/types.ts";
import { sendPipelineSummary, sendPipelineError } from "../../pipeline/notifications.ts";

// ─── Shared State ──────────────────────────────────────────────────

let sentMessages: Array<{
	customType: string;
	content: string;
	display?: boolean;
	details?: Record<string, unknown>;
}> = [];
let notifyMessages: string[] = [];
let statusValues: string[] = [];

beforeEach(() => {
	sentMessages = [];
	notifyMessages = [];
	statusValues = [];
});

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(): ExtensionAPI {
	return {
		exec: (async () => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
			signal: null,
			pid: 0,
		})) as unknown as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: ((msg: any) => {
			sentMessages.push(msg);
		}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: (message: string, _level?: string) => {
				notifyMessages.push(message);
			},
			setStatus: (_key: string, _val?: string) => {
				if (_val) statusValues.push(_val);
			},
			confirm: async () => true,
			theme: {
				fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
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

const mockAgentResults: PipelineAgentResult[] = [
	{
		agentName: "developer",
		status: "SUCCESS",
		durationMs: 10000,
		tokenCount: 5000,
		toolCount: 20,
	},
	{
		agentName: "auditor",
		status: "SUCCESS",
		durationMs: 5000,
		tokenCount: 3000,
		toolCount: 10,
	},
];

// ─── Tests ─────────────────────────────────────────────────────────

// Split from notifications.test.mts (issue #2035 Long File refactor).
describe("status-line count noun — runs (issue #1495)", () => {
	it("success setStatus → ✅ Done · N runs · duration", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(pi, ctx, mockAgentResults, "success", 42, "Test issue", mockConfig as any);
		const doneStatus = statusValues.find((s) => s.includes("Done"));
		assert.ok(doneStatus, "should set Done status");
		assert.ok(
			doneStatus!.includes("✅ Done · 2 runs · 15s"),
			`expected '✅ Done · 2 runs · 15s', got: ${doneStatus}`,
		);
	});

	it("single run → singular 'run' noun", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const single: PipelineAgentResult[] = [mockAgentResults[0]!];
		sendPipelineSummary(pi, ctx, single, "success", 42, "Test issue", mockConfig as any);
		const doneStatus = statusValues.find((s) => s.includes("Done"));
		assert.ok(
			doneStatus!.includes("✅ Done · 1 run · 10s"),
			`expected singular '1 run', got: ${doneStatus}`,
		);
	});

	it("pr-failed setStatus → ⚠️ Done (PR failed) · N runs · duration", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const prResult: PrCreationResult = { success: false, error: "Push failed" };
		sendPipelineSummary(
			pi,
			ctx,
			mockAgentResults,
			"success",
			42,
			"Test issue",
			mockConfig as any,
			undefined,
			prResult,
		);
		const prFailedStatus = statusValues.find((s) => s.includes("PR failed"));
		assert.ok(prFailedStatus, "should set PR-failed status");
		assert.ok(
			prFailedStatus!.includes("⚠️ Done (PR failed) · 2 runs · 15s"),
			`expected '⚠️ Done (PR failed) · 2 runs · 15s', got: ${prFailedStatus}`,
		);
	});

	it("conflicts setStatus → ⚠️ Conflicts remain · N runs · duration", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(
			pi,
			ctx,
			mockAgentResults,
			"success",
			42,
			"Test issue",
			mockConfig as any,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true, // unresolvedConflicts
		);
		const conflictsStatus = statusValues.find((s) => s.includes("Conflicts remain"));
		assert.ok(conflictsStatus, "should set conflicts status");
		assert.ok(
			conflictsStatus!.includes("⚠️ Conflicts remain · 2 runs · 15s"),
			`expected '⚠️ Conflicts remain · 2 runs · 15s', got: ${conflictsStatus}`,
		);
	});

	it("buildFailedStatusLine → ❌ Failed at <agent> · N runs", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const resultsWithFailed: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "FAILED",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
			{
				agentName: "developer",
				status: "SUCCESS (after retry)",
				durationMs: 2000,
				tokenCount: 800,
				toolCount: 12,
			},
		];
		sendPipelineError(
			pi,
			ctx,
			resultsWithFailed,
			42,
			"Test issue",
			mockConfig as any,
			"Error message",
		);
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(failedStatus, "should set failed status");
		assert.ok(
			failedStatus!.includes("❌ Failed at developer · 2 runs"),
			`expected '❌ Failed at developer · 2 runs', got: ${failedStatus}`,
		);
	});
});

// ─── Tests: sendPipelineError — errorMsg forwarding to summary ────

describe("sendPipelineError — errorMsg in summary", () => {
	it("non-empty agentResults → errorMsg appears in summary content", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const results: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "SUCCESS",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
		];
		sendPipelineError(pi, ctx, results, 42, "Test issue", mockConfig as any, "Something broke");
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message");
		assert.ok(
			summaryMsg!.content.includes("**Error:** Something broke"),
			"error message should appear in summary content",
		);
	});

	it("empty agentResults → errorMsg still appears in summary", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineError(pi, ctx, [], 42, "Test issue", mockConfig as any, "Pre-dispatch failure");
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message with empty results");
		assert.ok(
			summaryMsg!.content.includes("**Error:** Pre-dispatch failure"),
			"error message should appear even with empty results",
		);
	});
});
