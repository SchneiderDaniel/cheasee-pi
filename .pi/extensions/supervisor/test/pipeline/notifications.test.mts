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
import {
	sendPipelineSummary,
	sendPipelineError,
	sendAgentResultMessage,
} from "../../pipeline/notifications.ts";

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

// ─── Tests: sendAgentResultMessage with taskPrompt ─────────────────

describe("sendAgentResultMessage — taskPrompt plumbing", () => {
	it("passes taskPrompt to details.taskPrompt", async () => {
		const pi = createMockPi();
		sendAgentResultMessage(pi, {
			agentName: "architect",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 5,
			tokenCount: 1000,
			durationMs: 5000,
			textOutput: "output",
			textOnly: "text",
			output: "raw output",
			summaryLine: "Worked",
			taskPrompt: "Build the feature",
		});
		const msg = sentMessages.find((m) => m.customType === "supervisor");
		assert.ok(msg, "should send supervisor message");
		assert.ok(msg!.details, "should have details");
		assert.equal(msg!.details!.taskPrompt, "Build the feature");
	});

	it("without taskPrompt — details.taskPrompt is undefined (backward compat)", async () => {
		const pi = createMockPi();
		sendAgentResultMessage(pi, {
			agentName: "architect",
			success: false,
			statusLabel: "FAILED",
			toolCount: 3,
			tokenCount: 500,
			durationMs: 2000,
			textOutput: "",
			textOnly: "",
			output: "",
			summaryLine: "Failed",
		});
		const msg = sentMessages.find((m) => m.customType === "supervisor");
		assert.ok(msg, "should send supervisor message");
		assert.equal(msg!.details?.taskPrompt, undefined);
	});

	it("passes empty-string taskPrompt as empty string", async () => {
		const pi = createMockPi();
		sendAgentResultMessage(pi, {
			agentName: "architect",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 0,
			tokenCount: 0,
			durationMs: 0,
			textOutput: "",
			textOnly: "",
			output: "",
			summaryLine: "",
			taskPrompt: "",
		});
		const msg = sentMessages.find((m) => m.customType === "supervisor");
		assert.ok(msg, "should send supervisor message");
		assert.ok(msg!.details, "should have details");
		assert.equal(msg!.details!.taskPrompt, "");
	});

	it("passes large taskPrompt without truncation (truncation is renderer concern)", async () => {
		const pi = createMockPi();
		const largePrompt = "a".repeat(10000);
		sendAgentResultMessage(pi, {
			agentName: "architect",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 0,
			tokenCount: 0,
			durationMs: 0,
			textOutput: "",
			textOnly: "",
			output: "",
			summaryLine: "",
			taskPrompt: largePrompt,
		});
		const msg = sentMessages.find((m) => m.customType === "supervisor");
		assert.ok(msg, "should send supervisor message");
		assert.ok(msg!.details, "should have details");
		assert.equal(msg!.details!.taskPrompt, largePrompt);
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

	it("sendPipelineError with empty agent results → no status set (existing behavior preserved)", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		sendPipelineError(pi, ctx, [], 42, "Test issue", mockConfig as any, "Error message");
		// sendPipelineError with empty results should not call setStatus with Failed text
		const failedStatus = statusValues.find((s) => s.includes("Failed at"));
		assert.ok(!failedStatus, "should NOT set failed status with empty agent results");
	});
});
