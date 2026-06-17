// ─── Regression: GitHub issue #440 ────────────────────────────────
// thinking:high models may emit zero text/thinking deltas. Full JSON arrives
// in message_update.done / message_end thinking blocks and still must produce
// a GitHub issue comment.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { processSessionEvent } from "../event/session-events.ts";
import { buildAgentRunResult } from "../session/result.ts";
import { extractAgentCommentBody } from "../github/comment.ts";
import { handlePostAgentSuccess } from "../pipeline/stages.ts";
import type { AgentRunState, FilteredIssueData, SupervisorConfig } from "../config/types.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
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
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

function createMockPi(calls: ExecCall[]): ExtensionAPI {
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve({ code: 0, stdout: "", stderr: "" });
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
			theme: { fg: (_style: string, text: string) => text },
		},
	} as unknown as ExtensionCommandContext;
}

const config: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: { Architecture: "architect" },
	codeowners: ["owner"],
	defaultBranch: "main",
	remote: "origin",
};

const filteredData: FilteredIssueData = { body: "", comments: [] };

describe("issue #440 — thinking-only architect output posts comment", () => {
	it("captures done/message_end thinking JSON and passes it to postIssueComment", async () => {
		const state = createState();
		const commentBody = "## Architecture\nThinking-only architecture comment";
		const finalJson = JSON.stringify(
			{
				action: "COMPLETE",
				agentName: "architect",
				commentBody,
				summary: "Architecture ready",
			},
			null,
			2,
		);
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: finalJson }],
			usage: { totalTokens: 1234 },
		};

		// SDK path for thinking:high: no text_delta/thinking_delta events, full
		// response arrives in message_update.done and then message_end.
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "done" },
				message,
			},
			state,
		);
		processSessionEvent({ type: "message_end", message }, state);

		assert.equal(state.textOutputLines.length, 0, "thinking-only output has no text blocks");
		assert.equal(state.thinkingOutputLines.length, 1, "thinking JSON captured once");
		assert.ok(
			state.fullLog.some((line) => line.startsWith("💭")),
			"fullLog has thinking lines",
		);

		const result = buildAgentRunResult(state, "architect", true, 1000, [message]);
		assert.equal(result.textOnly, "", "textOnly stays empty for thinking-only output");
		assert.ok(result.textOutput.includes("💭"), "textOutput includes prefixed thinking log");
		assert.ok(result.output.includes("[ASSISTANT THINKING]"), "raw output includes thinking block");
		assert.equal(extractAgentCommentBody(result.textOutput), commentBody);
		assert.equal(extractAgentCommentBody(result.output), commentBody);
		assert.equal(extractAgentCommentBody(result.thinkingOutput || ""), commentBody);

		const calls: ExecCall[] = [];
		const pi = createMockPi(calls);
		const success = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			result,
			"architect",
			440,
			config,
			filteredData,
			undefined,
			undefined,
			"Bug: supervisor - architect comment not posted",
		);

		assert.equal(success, true);
		// gh() wrapper may call bash with GH_TOKEN injection or gh directly
		const commentCall = calls.find((call) => call.cmd === "gh" || call.cmd === "bash");
		assert.ok(commentCall, "postIssueComment should call gh");
		// Extract gh subcommand args: if bash wrapper, they start at index 3 (after -c, shellCmd, _)
		const ghArgs = commentCall.cmd === "bash" ? commentCall.args.slice(3) : commentCall.args;
		// postIssueComment uses --body-file with temp file for large bodies
		assert.equal(ghArgs[0], "issue");
		assert.equal(ghArgs[1], "comment");
		assert.equal(ghArgs[2], "440");
		assert.equal(ghArgs[3], "--repo");
		assert.equal(ghArgs[4], "owner/repo");
		assert.equal(ghArgs[5], "--body-file");
		assert.ok(ghArgs[6]?.includes(".md"), "body written to temp file");
	});
});
