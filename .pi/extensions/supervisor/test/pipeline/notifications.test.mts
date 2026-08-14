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

describe("sendPipelineSummary()", () => {
	it("sends pipeline-summary message with overall status 'success'", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(pi, ctx, mockAgentResults, "success", 42, "Test issue", mockConfig as any);
		// Should send a supervisor-summary message
		assert.ok(sentMessages.length >= 1, "should send at least one message");
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send supervisor-summary message");
		assert.ok(summaryMsg!.content.includes("✅"), "success should use ✅ emoji");
		assert.ok(summaryMsg!.content.includes("Pipeline Complete"), "should say Pipeline Complete");
	});

	it("notifies 'Pipeline complete.' on success", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(pi, ctx, mockAgentResults, "success", 42, "Test issue", mockConfig as any);
		const pipelineComplete = notifyMessages.find((m) => m.includes("Pipeline complete"));
		assert.ok(pipelineComplete, "should notify Pipeline complete");
		assert.ok(
			!pipelineComplete!.includes("PR creation failed"),
			"should not mention PR failure on clean success",
		);
	});

	it("includes PR creation success info in summary when prCreationResult.success=true", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const prResult: PrCreationResult = { success: true, prNumber: 456 };
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
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message");
		assert.ok(summaryMsg!.content.includes("#456"), "should mention PR number");
		assert.ok(summaryMsg!.content.includes("created"), "should say PR was created");
	});

	it("warns about PR creation failure when prCreationResult.success=false", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const prResult: PrCreationResult = { success: false, error: "Push failed: network error" };
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
		// Should use warning-level emoji
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message");
		assert.ok(summaryMsg!.content.includes("⚠️"), "failed PR should use ⚠️ emoji");
		assert.ok(
			summaryMsg!.content.includes("PR creation failed"),
			"should mention PR creation failed",
		);

		// Notification should indicate PR creation failed
		const prFailedMsg = notifyMessages.find((m) => m.includes("PR creation failed"));
		assert.ok(prFailedMsg, "should notify about PR creation failure");
	});

	it("reports 'failed' status correctly", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(pi, ctx, mockAgentResults, "failed", 42, "Test issue", mockConfig as any);
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message");
		assert.ok(summaryMsg!.content.includes("❌"), "failed status should use ❌ emoji");
		assert.ok(summaryMsg!.content.includes("Pipeline Failed"), "should say Pipeline Failed");
	});

	it("reports 'stopped' status correctly with stopReason", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(
			pi,
			ctx,
			mockAgentResults,
			"stopped",
			42,
			"Test issue",
			mockConfig as any,
			"Agent output unclear",
		);
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message");
		assert.ok(summaryMsg!.content.includes("⏹"), "stopped status should use ⏹ emoji");
		assert.ok(summaryMsg!.content.includes("Pipeline Stopped"), "should say Pipeline Stopped");
		assert.ok(summaryMsg!.content.includes("Agent output unclear"), "should include stop reason");
	});

	it("Does NOT say 'Pipeline complete' when auditor rejects (overallStatus stopped)", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineSummary(
			pi,
			ctx,
			mockAgentResults,
			"stopped",
			42,
			"Test issue",
			mockConfig as any,
			"Rejection limit reached",
		);
		// Should NOT say pipeline complete for stopped status
		const pipelineComplete = notifyMessages.find((m) => m.includes("Pipeline complete"));
		assert.ok(!pipelineComplete, "should NOT say Pipeline complete when stopped");
		// Should say Pipeline stopped
		const stoppedMsg = notifyMessages.find((m) => m.includes("Pipeline stopped"));
		assert.ok(stoppedMsg, "should say Pipeline stopped");
	});

	it("handles bellOnComplete config", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const configWithBell = { ...mockConfig, bellOnComplete: true };
		// Just verify it doesn't throw — bell writes \x07 to stdout
		sendPipelineSummary(
			pi,
			ctx,
			mockAgentResults,
			"success",
			42,
			"Test issue",
			configWithBell as any,
		);
		// Message still sent
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary even with bell");
	});
});

describe("sendPipelineError()", () => {
	it("sends error notification and summary on pipeline failure", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineError(
			pi,
			ctx,
			mockAgentResults,
			42,
			"Test issue",
			mockConfig as any,
			"Something went wrong",
		);
		// Error notification
		const errorNotify = notifyMessages.find((m) => m.includes("Something went wrong"));
		assert.ok(errorNotify, "should notify about error");

		// Summary message
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send summary message on error");
	});
});

// ─── Tests: notification status setting block extraction ────────────

describe("buildFailedStatusLine — extracted helper", () => {
	it("sendPipelineSummary with overallStatus 'failed' and last agent FAILED → status text contains agent name", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const resultsWithFailed: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "SUCCESS",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
			{ agentName: "auditor", status: "FAILED", durationMs: 500, tokenCount: 300, toolCount: 5 },
		];
		sendPipelineSummary(pi, ctx, resultsWithFailed, "failed", 42, "Test issue", mockConfig as any);
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(failedStatus, "should set failed status");
		assert.ok(
			failedStatus!.includes("auditor"),
			`expected 'auditor' in status, got: ${failedStatus}`,
		);
	});

	it("sendPipelineSummary with overallStatus 'failed' and no FAILED agent → status text contains 'unknown'", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const resultsWithoutFailed: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "SUCCESS",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
			{ agentName: "auditor", status: "SUCCESS", durationMs: 500, tokenCount: 300, toolCount: 5 },
		];
		sendPipelineSummary(
			pi,
			ctx,
			resultsWithoutFailed,
			"failed",
			42,
			"Test issue",
			mockConfig as any,
		);
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(failedStatus, "should set failed status");
		assert.ok(
			failedStatus!.includes("unknown"),
			`expected 'unknown' in status, got: ${failedStatus}`,
		);
	});

	it("sendPipelineError with FAILED agent in results → status text contains agent name", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const resultsWithFailed: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "SUCCESS",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
			{ agentName: "auditor", status: "FAILED", durationMs: 500, tokenCount: 300, toolCount: 5 },
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
			failedStatus!.includes("auditor"),
			`expected 'auditor' in status, got: ${failedStatus}`,
		);
	});

	it("sendPipelineError with no FAILED agent → status text contains 'unknown'", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const resultsWithoutFailed: PipelineAgentResult[] = [
			{
				agentName: "developer",
				status: "SUCCESS",
				durationMs: 1000,
				tokenCount: 500,
				toolCount: 10,
			},
			{ agentName: "auditor", status: "SUCCESS", durationMs: 500, tokenCount: 300, toolCount: 5 },
		];
		sendPipelineError(
			pi,
			ctx,
			resultsWithoutFailed,
			42,
			"Test issue",
			mockConfig as any,
			"Error message",
		);
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(failedStatus, "should set failed status");
		assert.ok(
			failedStatus!.includes("unknown"),
			`expected 'unknown' in status, got: ${failedStatus}`,
		);
	});

	it("sendPipelineError with empty agent results → supervisor-summary still sent with (none) row and errorMsg", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineError(pi, ctx, [], 42, "Test issue", mockConfig as any, "Dispatch error");
		// Summary should be sent even with empty results
		const summaryMsg = sentMessages.find((m) => m.customType === "supervisor-summary");
		assert.ok(summaryMsg, "should send supervisor-summary even with empty agent results");
		assert.ok(summaryMsg!.content.includes("(none)"), "should show (none) row for empty results");
		assert.ok(summaryMsg!.content.includes("**Error:** Dispatch error"), "should include error message");
		// Should not set failed status with empty agent results
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(!failedStatus, "should NOT set failed status with empty agent results");
	});
});

// ─── Tests: status-line count noun — "runs" not "agents" (issue #1495) ──
// Each PipelineAgentResult entry is one dispatch (retries push their own row),
// so the status lines label the count as runs.

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
			{ agentName: "developer", status: "SUCCESS", durationMs: 1000, tokenCount: 500, toolCount: 10 },
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
