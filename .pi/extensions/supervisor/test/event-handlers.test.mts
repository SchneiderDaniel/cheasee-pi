// ─── Tests: event-handlers.ts — shared handler functions ──────────
// Phase 2: Each handler is a standalone pure function.
// Tests mirror the scenarios from agent-stream.test.mts and
// session-events.test.mts but target the shared handlers directly.

// Augment AgentRunState with cache fields for test compilation
// These are local to this test file - the real AgentRunState will have them after implementation
interface AgentRunStateWithCache {
	cacheRead?: number;
	cacheWrite?: number;
}

type FullAgentRunState = AgentRunState & AgentRunStateWithCache;

function createStateWithCache(overrides?: Partial<FullAgentRunState>): FullAgentRunState {
	return {
		...createState(overrides),
		cacheRead: undefined,
		cacheWrite: undefined,
		...(overrides as any),
	};
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types";
import {
	handleToolExecutionStart,
	handleToolExecutionEnd,
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingEnd,
	handleTextStart,
	handleTextDelta,
	handleTextEnd,
	handleMessageEnd,
	handleDone,
	handleContextInfo,
	phasePriority,
} from "../event/handlers.ts";

// ─── Helpers ──────────────────────────────────────────────────────

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

// ─── phasePriority ────────────────────────────────────────────────

describe("phasePriority", () => {
	it("returns numeric priority: tool > thinking > text > idle", () => {
		assert.equal(phasePriority("tool"), 3);
		assert.equal(phasePriority("thinking"), 2);
		assert.equal(phasePriority("text"), 1);
		assert.equal(phasePriority("idle"), 0);
	});
});

// ─── handleToolExecutionStart ─────────────────────────────────────

describe("handleToolExecutionStart", () => {
	it("sets phase to tool, records tool name and args", () => {
		const state = createState();
		const result = handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "read_file",
			args: { path: "/x" },
		});
		assert.equal(state.phase, "tool");
		assert.equal(state.currentTool, "read_file");
		assert.ok(state.currentToolArgs);
		assert.equal(state.lastToolName, "read_file");
		assert.ok(state.fullLog.some((l) => l.includes("read_file")));
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("returns workingChange=false when already in tool phase", () => {
		const state = createState({ phase: "tool" });
		const result = handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "bash",
		});
		assert.equal(result.workingChange, false);
	});

	// ── New format tests (Phase 2) ──

	it('formats bash with command: log entry is "$ npm test"', () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "bash",
			args: { command: "npm test" },
		});
		assert.ok(state.fullLog.some((l) => l === "$ npm test"));
	});

	it('formats read with path: log entry is "read /x"', () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "read",
			args: { path: "/x" },
		});
		assert.ok(state.fullLog.some((l) => l === "read /x"));
	});

	it('formats write with path+content: log entry is "write /x (1 line)"', () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "write",
			args: { path: "/x", content: "abc" },
		});
		assert.ok(state.fullLog.some((l) => l === "write /x (1 line)"));
	});

	it("state.currentToolArgs still stores raw JSON string (unchanged)", () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "bash",
			args: { command: "npm test" },
		});
		// currentToolArgs must be the raw JSON string, not the formatted output
		assert.equal(state.currentToolArgs, '{"command":"npm test"}');
	});

	it("state.currentTool is still the raw tool name (unchanged)", () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "read",
			args: { path: "/x" },
		});
		assert.equal(state.currentTool, "read");
	});

	it("unknown tool uses fallback format with JSON preview", () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "web_search",
			args: { query: "typescript" },
		});
		const logEntry = state.fullLog.find((l) => l.includes("web_search:"));
		assert.ok(logEntry, "log entry should contain web_search:");
		assert.ok(logEntry!.includes("typescript"));
	});

	it("no args produces bare tool format", () => {
		const state = createState();
		handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "bash",
		});
		assert.ok(state.fullLog.some((l) => l === "$"));
	});
});

// ─── handleToolExecutionEnd ───────────────────────────────────────

describe("handleToolExecutionEnd", () => {
	it("increments toolCount, resets tool state, sets phase idle", () => {
		const state = createState({ toolCount: 5, lastToolName: "read_file" });
		const result = handleToolExecutionEnd(state, {
			kind: "tool_execution_end",
			toolName: "read_file",
			isError: false,
		});
		assert.equal(state.toolCount, 6);
		assert.equal(state.currentTool, undefined);
		assert.equal(state.currentToolArgs, undefined);
		assert.equal(state.phase, "idle");
		assert.ok(state.fullLog.some((l) => l.includes("✓")));
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("marks error with ✗", () => {
		const state = createState();
		handleToolExecutionEnd(state, { kind: "tool_execution_end", toolName: "bash", isError: true });
		assert.ok(state.fullLog.some((l) => l.includes("✗")));
	});
});

// ─── handleThinkingStart ──────────────────────────────────────────

describe("handleThinkingStart", () => {
	it("resets thinkingPushedThisTurn flag", () => {
		const state = createState({ thinkingPushedThisTurn: true });
		const result = handleThinkingStart(state, { kind: "thinking_start" });
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});
});

// ─── handleTextStart ──────────────────────────────────────────────

describe("handleTextStart", () => {
	it("resets textPushedThisTurn flag", () => {
		const state = createState({ textPushedThisTurn: true });
		const result = handleTextStart(state, { kind: "text_start" });
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});
});

// ─── handleThinkingDelta ──────────────────────────────────────────

describe("handleThinkingDelta", () => {
	it("appends delta to liveThinking and pushes complete lines to log", () => {
		const state = createState();
		const result = handleThinkingDelta(state, {
			kind: "thinking_delta",
			delta: "step 1\nstep 2\n",
		});
		assert.equal(state.liveThinking, "");
		assert.ok(state.fullLog.some((l) => l.includes("step 1")));
		assert.ok(state.fullLog.some((l) => l.includes("step 2")));
		assert.equal(result.flush, true);
	});

	it("does nothing with empty delta", () => {
		const state = createState();
		const result = handleThinkingDelta(state, { kind: "thinking_delta", delta: "" });
		assert.equal(state.liveThinking, "");
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});
});

// ─── handleThinkingEnd ────────────────────────────────────────────

describe("handleThinkingEnd", () => {
	it("does NOT set flag when liveThinking is empty — allows done/message_end to push", () => {
		const state = createState();
		const result = handleThinkingEnd(state, { kind: "thinking_end" });
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.liveThinking, "");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("pushes content when liveThinking has data and sets flag", () => {
		const state = createState({ liveThinking: "deep thought" });
		handleThinkingEnd(state, { kind: "thinking_end" });
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.liveThinking, "");
		assert.ok(state.thinkingOutputLines.length > 0);
	});
});

// ─── handleTextDelta ──────────────────────────────────────────────

describe("handleTextDelta", () => {
	it("appends delta and pushes complete lines to log", () => {
		const state = createState();
		const result = handleTextDelta(state, { kind: "text_delta", delta: "Hello\nWorld\n" });
		assert.equal(state.liveText, "");
		assert.ok(state.fullLog.some((l) => l === "Hello"));
		assert.ok(state.fullLog.some((l) => l === "World"));
		assert.equal(result.flush, true);
	});

	it("does nothing with empty delta", () => {
		const state = createState();
		const result = handleTextDelta(state, { kind: "text_delta", delta: "" });
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});
});

// ─── handleTextEnd ────────────────────────────────────────────────

describe("handleTextEnd", () => {
	it("does NOT set flag when liveText is empty — allows done/message_end to push", () => {
		const state = createState();
		const result = handleTextEnd(state, { kind: "text_end" });
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.liveText, "");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("pushes content when liveText has data and sets flag", () => {
		const state = createState({ liveText: "some output" });
		handleTextEnd(state, { kind: "text_end" });
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "some output");
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleTextEnd(state, {
			kind: "text_end",
			usage: { totalTokens: 100, input: 40, output: 60 },
		});
		assert.equal(state.tokenCount, 100);
	});

	it("handles usage via input+output fallback", () => {
		const state = createState();
		handleTextEnd(state, {
			kind: "text_end",
			usage: { input: 30, output: 20 },
		});
		assert.equal(state.tokenCount, 50);
	});

	it("treats missing input as 0 via ?? 0 fallback", () => {
		const state = createState();
		handleTextEnd(state, {
			kind: "text_end",
			usage: { output: 50 },
		});
		assert.equal(state.tokenCount, 50);
	});
});

// ─── handleMessageEnd ─────────────────────────────────────────────

describe("handleMessageEnd", () => {
	it("processes assistant role: pushes thinking to both thinkingOutputLines and fullLog, text to textOutputLines", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "deep" },
					{ type: "text", text: "answer" },
				],
			},
		});
		assert.equal(state.textOutputLines[0], "answer");
		// thinking at message_end goes to both thinkingOutputLines and fullLog (with 💭 prefix)
		assert.ok(state.thinkingOutputLines[0]?.includes("deep"));
		assert.ok(state.fullLog.some((l) => l.includes("💭") && l.includes("deep")));
		// Flags are RESET at the end of message_end (end of turn)
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textPushedThisTurn, false);
	});

	it("recovers multi-line thinking to thinkingOutputLines at message_end", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "line 1\nline 2\nline 3" },
					{ type: "text", text: "answer" },
				],
			},
		});
		// Multi-line thinking is joined into a single thinkingOutputLines entry
		assert.equal(state.thinkingOutputLines.length, 1);
		assert.ok(state.thinkingOutputLines[0].includes("line 1"));
		assert.ok(state.thinkingOutputLines[0].includes("line 2"));
		assert.ok(state.thinkingOutputLines[0].includes("line 3"));
		assert.equal(state.textOutputLines[0], "answer");
	});

	it("skips thinking recovery when thinkingPushedThisTurn is already true", () => {
		const state = createState({ thinkingPushedThisTurn: true });
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "should not appear" },
					{ type: "text", text: "answer" },
				],
			},
		});
		// thinkingPushedThisTurn was already set — thinking recovery is skipped
		assert.equal(state.thinkingOutputLines.length, 0);
		assert.equal(state.textOutputLines[0], "answer");
	});

	it("processes toolResult role: pushes tool result log", () => {
		const state = createState({ lastToolName: "read_file" });
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "file content" }],
				toolName: "read_file",
			},
		});
		assert.ok(state.fullLog.some((l) => l.includes("📋")));
	});

	it("checks budget: tool call limit", () => {
		const state = createState({ toolCount: 30, maxToolCalls: 30 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("30"));
	});

	it("checks budget: token budget", () => {
		const state = createState({ tokenCount: 500000, agentTokenBudget: 500000 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("500000"));
	});

	it("does not set budgetExceeded when both limits are 0", () => {
		const state = createState({ toolCount: 100, tokenCount: 999999 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, false);
	});

	it("resets turn flags and phase to idle", () => {
		const state = createState({
			thinkingPushedThisTurn: true,
			textPushedThisTurn: true,
			phase: "tool",
		});
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.phase, "idle");
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { totalTokens: 200, input: 100, output: 100 },
			},
		});
		assert.equal(state.tokenCount, 200);
	});

	it("preserves tokenCount when usage has only cache stats (no totalTokens/input/output)", () => {
		const state = createState({ tokenCount: 500 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { cacheRead: 76288, cacheWrite: 500 },
			},
		});
		assert.equal(state.tokenCount, 500);
	});

	it("preserves tokenCount when totalTokens is 0 and input/output are absent", () => {
		const state = createState({ tokenCount: 200 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { totalTokens: 0 },
			},
		});
		assert.equal(state.tokenCount, 200);
	});

	it("uses input+output fallback when totalTokens is absent", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { input: 100, output: 50 },
			},
		});
		assert.equal(state.tokenCount, 150);
	});

	it("treats input:0 as valid via ?? 0 fallback", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { input: 0, output: 50 },
			},
		});
		assert.equal(state.tokenCount, 50);
	});

	it("preserves tokenCount when no usage object is present", () => {
		const state = createState({ tokenCount: 100 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.tokenCount, 100);
	});
});

// ─── handleDone ───────────────────────────────────────────────────

describe("handleDone", () => {
	it("processes text content and sets textPushedThisTurn", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "final answer" }],
			},
		});
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "final answer");
	});

	it("captures text from done when text_end had no content — regression: empty text_end + done flow", () => {
		// Simulates SDK: text_start → text_end(empty) → done(with full content)
		const state = createState();
		// text_end fires but liveText is empty — flag should NOT be set after fix
		handleTextEnd(state, { kind: "text_end" });
		assert.equal(state.textPushedThisTurn, false, "flag must NOT be set after empty text_end");
		// done event carries actual text content
		const jsonOutput = '{"commentBody":"This is the PR comment","approved":true}';
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: jsonOutput }],
			},
		});
		assert.equal(state.textPushedThisTurn, true, "flag must be set after done pushes text");
		assert.equal(state.textOutputLines.length, 1, "text must be captured");
		assert.ok(
			state.textOutputLines[0].includes("This is the PR comment"),
			"comment body in textOutput",
		);
		assert.ok(state.textOutputLines[0].includes("approved"), "full JSON in textOutput");
	});

	it("processes thinking content and sets thinkingPushedThisTurn", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		});
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.ok(state.thinkingOutputLines[0]?.includes("deep thought"));
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				usage: { input: 100, output: 50 },
			},
		});
		assert.equal(state.tokenCount, 150);
	});

	it("skips text push when textPushedThisTurn is already true", () => {
		const state = createState({ thinkingPushedThisTurn: true, textPushedThisTurn: true });
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "should not appear" }],
			},
		});
		assert.equal(state.textOutputLines.length, 0);
	});

	it("clears liveText and liveThinking", () => {
		const state = createState({ liveText: "buffer", liveThinking: "thought" });
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "result" }],
			},
		});
		assert.equal(state.liveText, "");
		assert.equal(state.liveThinking, "");
	});

	it("sets phase to idle", () => {
		const state = createState({ phase: "tool" });
		handleDone(state, {
			kind: "done",
			message: { content: [{ type: "text", text: "result" }] },
		});
		assert.equal(state.phase, "idle");
	});
});

// ─── handleContextInfo ────────────────────────────────────────────

describe("handleContextInfo", () => {
	it("sets context tokens and window", () => {
		const state = createState();
		const result = handleContextInfo(state, {
			kind: "context_info",
			contextTokens: 5000,
			contextWindow: 10000,
		});
		assert.equal(state.contextTokens, 5000);
		assert.equal(state.contextWindow, 10000);
		assert.equal(state.contextInfoReceived, true);
		assert.equal(result.flush, true);
	});

	it("returns flush=false when values are invalid (window=0)", () => {
		const state = createState();
		const result = handleContextInfo(state, {
			kind: "context_info",
			contextTokens: 0,
			contextWindow: 0,
		});
		assert.equal(result.flush, false);
		assert.equal(state.contextInfoReceived, false);
	});
});

// ─── handleMessageEnd — cache stats ──────────────────────────────

describe("handleMessageEnd — cache stats", () => {
	it("extracts cacheRead and cacheWrite from message usage", () => {
		const state = createStateWithCache() as any;
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { cacheRead: 76288, cacheWrite: 0 },
			},
		});
		assert.equal(state.cacheRead, 76288);
		assert.equal(state.cacheWrite, 0);
	});

	it("does not set cacheRead/cacheWrite when usage is absent", () => {
		const state = createStateWithCache() as any;
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.cacheRead, undefined);
		assert.equal(state.cacheWrite, undefined);
	});

	it("does not set cacheRead/cacheWrite when usage has no cache fields", () => {
		const state = createStateWithCache() as any;
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { totalTokens: 100, input: 50, output: 50 },
			},
		});
		assert.equal(state.cacheRead, undefined);
		assert.equal(state.cacheWrite, undefined);
	});
});

// ─── handleDone — cache stats ─────────────────────────────────────

describe("handleDone — cache stats", () => {
	it("extracts cacheRead and cacheWrite from message usage", () => {
		const state = createStateWithCache() as any;
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "final" }],
				usage: { cacheRead: 50000, cacheWrite: 1000 },
			},
		});
		assert.equal(state.cacheRead, 50000);
		assert.equal(state.cacheWrite, 1000);
	});

	it("does not set cacheRead/cacheWrite when usage is absent", () => {
		const state = createStateWithCache() as any;
		handleDone(state, {
			kind: "done",
			message: { content: [{ type: "text", text: "final" }] },
		});
		assert.equal(state.cacheRead, undefined);
		assert.equal(state.cacheWrite, undefined);
	});
});

// ─── handleDone — string content (no streaming models) ────────────
// Use 'as any' casts because the NormalizedEvent type defines message.content
// as Array but at runtime the SDK can deliver a string for non-streaming models.

describe("handleDone — string content (no streaming models)", () => {
	it("extracts text from string content (no array blocks)", () => {
		const state = createState();
		const text = '{"action":"COMPLETE","agentName":"architect","commentBody":"Arch review"}';
		handleDone(state, {
			kind: "done",
			message: {
				content: text as any,
			},
		});
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines.length, 1);
		assert.ok(state.textOutputLines[0].includes("Arch review"));
		assert.ok(state.fullLog.some((l: string) => l.includes("Arch review")));
	});

	it("extracts multi-line text from string content", () => {
		const state = createState();
		const text = "Line 1\nLine 2\nLine 3";
		handleDone(state, {
			kind: "done",
			message: {
				content: text as any,
			},
		});
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "Line 1\nLine 2\nLine 3");
		assert.ok(state.fullLog.includes("Line 1"));
		assert.ok(state.fullLog.includes("Line 3"));
	});

	it("skips string content when textPushedThisTurn already true", () => {
		const state = createState({ textPushedThisTurn: true });
		handleDone(state, {
			kind: "done",
			message: {
				content: "should not appear" as any,
			},
		});
		assert.equal(state.textOutputLines.length, 0);
	});

	it("skips empty/whitespace string content", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: "   \n   " as any,
			},
		});
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
	});

	it("still processes array content alongside string content path", () => {
		// Regression: ensure array content path still works
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "array content works" }],
			},
		});
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "array content works");
	});
});
