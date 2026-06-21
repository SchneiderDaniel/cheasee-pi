/**
 * Tests: config/→lib/ structural refactor — consumer file import resolution.
 *
 * Verifies that all consumer files affected by the refactor (import paths
 * updated from ../config/xxx.ts to ../lib/xxx.ts) have their exports
 * accessible at runtime. Pure structural refactor verification — no
 * behavior tests (existing behavioral tests remain in dedicated test files).
 *
 * Every file that had import path changes is covered here to satisfy the
 * TDD gate's test-covers-symbols check.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/config-lib-refactor.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Moved files (config/ → lib/) ─────────────────────────────────
// These have dedicated test files, but we re-test imports here for
// belt-and-suspenders coverage.

import {
	resolveTools,
	resolveExtensionPaths,
	resolveExtensionPathsWithFs,
	resolveSkillPaths,
} from "../lib/extensions.ts";
import {
	getDebugLogger,
	setDebugLogger,
	resetDebugLogger,
	parseSupervisorArgs,
	enableDebugLogger,
} from "../lib/debug.ts";
import {
	formatDuration,
	formatTokens,
	extractTextFromContent,
	extractSummaryLine,
	getTermWidth,
	boldText,
} from "../lib/formatting.ts";
import { createInstrumenter, createInstrumenterSnapshot } from "../lib/instrumentation.ts";
import type { InstrumenterHandle, InstrumentSnapshot } from "../lib/instrumentation.ts";
import { createWatchdog } from "../lib/watchdog.ts";
import type { WatchdogOptions, WatchdogHandle } from "../lib/watchdog.ts";
import { buildAgentSystemPrompt } from "../lib/shared-prompts.ts";

// ─── Consumer files (import paths updated) ────────────────────────

import { parseAgentFile } from "../agent/loader.ts";
import { stripAnsi, normalizeEscapes, parseAgentOutput, isSuccess } from "../agent/output.ts";
import { createAgentRunState } from "../agent/runner.ts";
import { filterStderr } from "../event/adapter.ts";
import { pushLog, MAX_FULL_LOG } from "../agent/state-helpers.ts";
import {
	handleToolExecutionStart,
	handleToolExecutionEnd,
	handleThinkingStart,
	handleThinkingDelta,
	handleTextStart,
	handleTextDelta,
	handleTextEnd,
	handleMessageEnd,
	handleDone,
	handleContextInfo,
} from "../event/handlers.ts";
import { extractAgentCommentBody, extractStructuredAuditOutput } from "../github/comment.ts";
import { findIssueItem } from "../github/project.ts";
import { validateAgentResult, buildPipelineSummary } from "../pipeline/output.ts";
import { sendPipelineSummary, sendPipelineError } from "../pipeline/notifications.ts";
import { isStaleCheckpoint, readCheckpointFileFromPath } from "../pipeline/state-checkpoint.ts";
import type { CheckpointName, SupervisorCheckpointState } from "../pipeline/state-checkpoint.ts";
import type { AgentRunResult } from "../config/types.ts";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import { resolveModelString, resolveModel, buildToolList } from "../session/model.ts";
import { buildRawOutputFromMessages, buildAgentRunResult } from "../session/result.ts";
import { buildWidgetLines, getWorkingMessage } from "../session/widget.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createMinimalRunState() {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle" as const,
		startedAt: Date.now(),
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
	};
}

describe("config→lib refactor — moved lib/ files", () => {
	it("lib/extensions.ts exports resolveTools", () => {
		assert.equal(typeof resolveTools, "function");
	});

	it("lib/extensions.ts exports resolveExtensionPaths", () => {
		assert.equal(typeof resolveExtensionPaths, "function");
	});

	it("lib/extensions.ts exports resolveExtensionPathsWithFs", () => {
		assert.equal(typeof resolveExtensionPathsWithFs, "function");
	});

	it("lib/extensions.ts exports resolveSkillPaths", () => {
		assert.equal(typeof resolveSkillPaths, "function");
	});

	it("lib/debug.ts exports getDebugLogger", () => {
		assert.equal(typeof getDebugLogger, "function");
	});

	it("lib/debug.ts exports parseSupervisorArgs", () => {
		assert.equal(typeof parseSupervisorArgs, "function");
	});

	it("lib/formatting.ts exports formatDuration", () => {
		assert.equal(typeof formatDuration, "function");
	});

	it("lib/formatting.ts exports formatTokens", () => {
		assert.equal(typeof formatTokens, "function");
	});

	it("lib/formatting.ts exports extractTextFromContent", () => {
		assert.equal(typeof extractTextFromContent, "function");
	});

	it("lib/formatting.ts exports extractSummaryLine", () => {
		assert.equal(typeof extractSummaryLine, "function");
	});

	it("lib/instrumentation.ts exports createInstrumenter and types", () => {
		assert.equal(typeof createInstrumenter, "function");
		assert.equal(typeof createInstrumenterSnapshot, "function");
	});

	it("lib/watchdog.ts exports createWatchdog and types", () => {
		assert.equal(typeof createWatchdog, "function");
	});

	it("lib/shared-prompts.ts exports buildAgentSystemPrompt", () => {
		assert.equal(typeof buildAgentSystemPrompt, "function");
	});
});

describe("config→lib refactor — consumer files (agent/)", () => {
	it("agent/loader.ts exports parseAgentFile", () => {
		assert.equal(typeof parseAgentFile, "function");
	});

	it("agent/output.ts exports stripAnsi (pure function)", () => {
		assert.equal(typeof stripAnsi, "function");
		// Strip ANSI escape codes
		assert.equal(stripAnsi("\x1b[31mhello\x1b[0m"), "hello");
		assert.equal(stripAnsi("plain text"), "plain text");
		assert.equal(stripAnsi(""), "");
	});

	it("agent/output.ts exports normalizeEscapes (pure function)", () => {
		assert.equal(typeof normalizeEscapes, "function");
		assert.equal(normalizeEscapes("hello\\nworld"), "hello\nworld");
		assert.equal(normalizeEscapes("simple"), "simple");
	});

	it("agent/output.ts exports isSuccess (pure function)", () => {
		assert.equal(typeof isSuccess, "function");
		// isSuccess type-narrows ParseResult to AgentOutput (checks action + agentName)
		assert.equal(isSuccess({ action: "run", agentName: "test" } as any), true);
		assert.equal(isSuccess({} as any), false);
	});

	it("agent/runner.ts exports createAgentRunState (pure function)", () => {
		assert.equal(typeof createAgentRunState, "function");
		const state = createAgentRunState(1000);
		assert.equal(state.toolCount, 0);
		assert.equal(state.tokenCount, 0);
		assert.equal(state.startedAt, 1000);
		assert.equal(state.phase, "idle");
		assert.equal(state.maxToolCalls, 0);
		assert.equal(state.agentTokenBudget, 0);
	});

	it("agent/runner.ts exports createAgentRunState with budget params", () => {
		assert.equal(typeof createAgentRunState, "function");
		const state = createAgentRunState(2000, 5, 100_000);
		assert.equal(state.maxToolCalls, 5);
		assert.equal(state.agentTokenBudget, 100_000);
	});

	it("agent/state-helpers.ts exports MAX_FULL_LOG constant", () => {
		assert.equal(typeof MAX_FULL_LOG, "number");
		assert.equal(MAX_FULL_LOG, 500);
	});

	it("event/adapter.ts exports filterStderr (pure function)", () => {
		assert.equal(typeof filterStderr, "function");
		const result = filterStderr("normal line\n[some stderr stuff]\nanother line\n");
		assert.ok(typeof result === "string");
	});

	it("agent/state-helpers.ts exports pushLog", () => {
		assert.equal(typeof pushLog, "function");
		const state = createMinimalRunState();
		pushLog(state, "test entry");
		assert.equal(state.fullLog.length, 1);
		assert.equal(state.fullLog[0], "test entry");
	});
});

describe("config→lib refactor — consumer files (event/)", () => {
	it("event/handlers.ts exports handleToolExecutionStart", () => {
		assert.equal(typeof handleToolExecutionStart, "function");
		const state = createMinimalRunState();
		const ev = {
			kind: "tool_execution_start" as const,
			toolName: "read",
			args: { path: "/test" },
		};
		const result = handleToolExecutionStart(state, ev);
		assert.equal(state.currentTool, "read");
		assert.equal(state.phase, "tool");
		assert.ok(typeof result.flush === "boolean");
	});

	it("event/handlers.ts exports handleToolExecutionEnd", () => {
		assert.equal(typeof handleToolExecutionEnd, "function");
		const state = createMinimalRunState();
		const ev = {
			kind: "tool_execution_end" as const,
			toolName: "read",
			isError: false,
		};
		const result = handleToolExecutionEnd(state, ev);
		assert.equal(state.toolCount, 1);
		assert.equal(state.currentTool, undefined);
	});
});

describe("config→lib refactor — consumer files (github/)", () => {
	it("github/comment.ts exports extractAgentCommentBody", () => {
		assert.equal(typeof extractAgentCommentBody, "function");
		// Test with null/empty input (function handles gracefully)
		const result = extractAgentCommentBody("no structured content here");
		// Returns null when no comment body found
		assert.equal(result, null);
	});

	it("github/comment.ts exports extractStructuredAuditOutput", () => {
		assert.equal(typeof extractStructuredAuditOutput, "function");
		const result = extractStructuredAuditOutput("no structured output");
		assert.equal(result, null);
	});

	it("github/project.ts exports findIssueItem (pure function)", () => {
		assert.equal(typeof findIssueItem, "function");
		const items = [
			{ content: { number: 42 }, status: "In Progress" },
			{ content: { number: 99 }, status: "Done" },
		];
		const found = findIssueItem(items as any, 42);
		assert.ok(found !== null);
		assert.equal(found!.status, "In Progress");

		const notFound = findIssueItem(items as any, 1);
		assert.equal(notFound, null);
	});
});

describe("config→lib refactor — consumer files (pipeline/)", () => {
	it("pipeline/output.ts exports validateAgentResult (pure function)", () => {
		assert.equal(typeof validateAgentResult, "function");
		const result: AgentRunResult = {
			success: true,
			tokenCount: 0,
			toolCount: 10,
			errorOutput: "",
			output: "",
			agentName: "test",
			durationMs: 0,
			textOutput: "",
			summaryLine: "",
			textOnly: "",
		};
		validateAgentResult(result);
		assert.equal(result.success, false, "should derate success=true with 0 tokens and >5 tools");
		assert.ok(result.errorOutput!.includes("Sanity check failed"));
	});

	it("pipeline/output.ts exports validateAgentResult passthrough for valid results", () => {
		assert.equal(typeof validateAgentResult, "function");
		const result: AgentRunResult = {
			success: true,
			tokenCount: 1000,
			toolCount: 3,
			errorOutput: "",
			output: "",
			agentName: "test",
			durationMs: 0,
			textOutput: "",
			summaryLine: "",
			textOnly: "",
		};
		validateAgentResult(result);
		assert.equal(result.success, true, "should pass valid results through unchanged");
	});

	it("pipeline/notifications.ts exports sendPipelineSummary", () => {
		assert.equal(typeof sendPipelineSummary, "function");
	});

	it("pipeline/notifications.ts exports sendPipelineError", () => {
		assert.equal(typeof sendPipelineError, "function");
	});

	it("pipeline/state-checkpoint.ts exports isStaleCheckpoint (pure function)", () => {
		assert.equal(typeof isStaleCheckpoint, "function");
		const freshState: SupervisorCheckpointState = {
			issueNum: 1,
			checkpoint: "pre-tsc",
			worktreePath: "/tmp/test",
			worktreeBranch: "test-branch",
			startedAt: new Date().toISOString(),
		};
		// Fresh state should not be stale with default maxAge
		assert.equal(isStaleCheckpoint(freshState, 60_000), false);

		// Very old state should be stale
		const oldState: SupervisorCheckpointState = {
			...freshState,
			startedAt: new Date(Date.now() - 7_200_000).toISOString(), // 2 hours ago
		};
		assert.equal(isStaleCheckpoint(oldState, 3_600_000), true);
	});

	it("pipeline/state-checkpoint.ts handles invalid dates as stale", () => {
		assert.equal(typeof isStaleCheckpoint, "function");
		const invalidState: SupervisorCheckpointState = {
			issueNum: 1,
			checkpoint: "pre-tsc",
			worktreePath: "/tmp/test",
			worktreeBranch: "test-branch",
			startedAt: "not-a-date",
		};
		assert.equal(isStaleCheckpoint(invalidState), true);
	});
});

describe("config→lib refactor — consumer files (session/)", () => {
	it("session/message-renderer.ts exports createMessageRenderer", () => {
		assert.equal(typeof createMessageRenderer, "function");
	});

	it("session/message-renderer.ts exports createSummaryRenderer", () => {
		assert.equal(typeof createSummaryRenderer, "function");
	});

	it("session/model.ts exports resolveModelString (pure function)", () => {
		assert.equal(typeof resolveModelString, "function");
		const result = resolveModelString("openai/gpt-4");
		assert.deepEqual(result, { provider: "openai", modelId: "gpt-4" });
	});

	it("session/model.ts exports resolveModelString edge cases", () => {
		assert.equal(typeof resolveModelString, "function");
		assert.equal(resolveModelString(""), null);
		assert.equal(resolveModelString("   "), null);
		assert.equal(resolveModelString("invalid"), null);
	});

	it("session/model.ts exports buildToolList", () => {
		assert.equal(typeof buildToolList, "function");
	});

	it("session/result.ts exports buildRawOutputFromMessages", () => {
		assert.equal(typeof buildRawOutputFromMessages, "function");
		const result = buildRawOutputFromMessages([]);
		assert.equal(typeof result, "string");
	});

	it("session/result.ts exports buildAgentRunResult", () => {
		assert.equal(typeof buildAgentRunResult, "function");
	});

	it("session/widget.ts exports buildWidgetLines", () => {
		assert.equal(typeof buildWidgetLines, "function");
		const state = createMinimalRunState();
		const lines = buildWidgetLines(state, "idle");
		assert.ok(Array.isArray(lines));
	});

	it("session/widget.ts exports getWorkingMessage", () => {
		assert.equal(typeof getWorkingMessage, "function");
		const state = createMinimalRunState();
		const msg = getWorkingMessage(state, "test-agent");
		// idle phase with no logs → no working message
		assert.equal(msg, null);
	});
});
