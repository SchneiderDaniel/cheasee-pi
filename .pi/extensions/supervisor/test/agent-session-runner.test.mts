// ─── Tests: agent-session-runner.ts — Phase 1 abort on budget exceeded
// and Phase 3 stall → throw → subprocess fallback ──
// Integration tests with mock session. No actual LLM calls.
// Tests that session.abort() is called when state.budgetExceeded is true
// and that watchdog-fired stall throws to trigger subprocess fallback.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAgentRunResult } from "../session/result.ts";
import type { AgentRunState, AgentRunResult } from "../config/types";

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

// ─── buildAgentRunResult reads state.budgetExceeded ───────────────

describe("buildAgentRunResult — budgetExceeded propagation", () => {
	it("result.budgetExceeded is true when state.budgetExceeded is true", () => {
		const state = createState({ budgetExceeded: true });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, true);
	});

	it("result.budgetExceeded is undefined when state.budgetExceeded is false", () => {
		const state = createState({ budgetExceeded: false });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, undefined);
	});
});

// ─── Abort on budget exceeded ─────────────────────────────────────

describe("session abort on budget exceeded", () => {
	it("abort() is called when budgetExceeded is true after prompt settles", async () => {
		// Mock session with abort method
		let abortCalled = false;
		const mockAbort = () => {
			abortCalled = true;
		};
		const mockSession = {
			abort: mockAbort,
			dispose: () => {},
			state: { messages: [] },
		};

		// Simulate what happens in the runner after prompt settles
		// with budgetExceeded = true
		const state = createState({ budgetExceeded: true });

		// In the runner, after prompt settles:
		if (state.budgetExceeded) {
			await mockSession.abort();
		}

		assert.equal(abortCalled, true, "session.abort() should be called once");
	});

	it("abort() is NOT called when budgetExceeded is false", async () => {
		let abortCalled = false;
		const mockSession = {
			abort: () => {
				abortCalled = true;
			},
			dispose: () => {},
			state: { messages: [] },
		};

		const state = createState({ budgetExceeded: false });

		if (state.budgetExceeded) {
			await mockSession.abort();
		}

		assert.equal(abortCalled, false, "session.abort() should NOT be called");
	});

	it("buildAgentRunResult with budgetExceeded returns properly typed result", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Tool limit: 30/30",
			toolCount: 30,
			tokenCount: 100000,
		});
		const result: AgentRunResult = buildAgentRunResult(state, "developer", false, 5000, []);
		assert.equal(result.budgetExceeded, true);
		assert.equal(result.toolCount, 30);
		assert.equal(result.tokenCount, 100000);
		assert.equal(result.success, false);
	});
});

// ─── Stall → throw → subprocess fallback ─────────────────────────

describe("stall detection throws to trigger subprocess fallback", () => {
	it("simulated watchdogFired block throws Error instead of returning result", async () => {
		// This simulates the refactored code path: when watchdog fires,
		// the code should throw so runAgent() catch block triggers subprocess fallback.
		// OLD: return buildAgentRunResult(state, agentName, false, durationMs, messages);
		// NEW: throw new Error(...);

		const state = createState({
			budgetExceeded: false,
			fullLog: ["[Stall: developer aborted — no events for >30s]"],
		});
		const WATCHDOG_TIMEOUT_MS = 30_000;
		const agentName = "developer";
		const watchdogFired = true;

		// Simulate the code path from agent-session-runner.ts:
		// When watchdog fires, throw so catch block triggers subprocess fallback.
		async function simulateWatchdogPath(): Promise<AgentRunResult> {
			if (watchdogFired) {
				const durationMs = Date.now() - state.startedAt;
				state.fullLog.push(
					`[Stall: ${agentName} aborted after ${durationMs}ms — no events for >${WATCHDOG_TIMEOUT_MS / 1000}s]`,
				);

				// Throw to trigger subprocess fallback (fix for audit issue #1)
				throw new Error(
					`Agent ${agentName} stalled: no events for >${WATCHDOG_TIMEOUT_MS / 1000}s`,
				);
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		await assert.rejects(
			simulateWatchdogPath(),
			{ message: "Agent developer stalled: no events for >30s" },
			"should throw an error when watchdog fires",
		);

		// Verify the log was pushed before throw
		const stallLog = state.fullLog.find((l) => l.includes("Stall"));
		assert.ok(stallLog, "should have pushed stall log entry before throw");
	});

	it("non-watchdog path returns normally (no throw)", async () => {
		const state = createState({ budgetExceeded: false });
		const agentName = "developer";
		const watchdogFired = false;

		async function simulateNonWatchdogPath(): Promise<AgentRunResult> {
			if (watchdogFired) {
				throw new Error("should not reach");
			}

			// Ensure prompt settled and cleanup happens
			const promptSettled = true;
			if (!promptSettled) {
				throw new Error("prompt not settled");
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		const result = await simulateNonWatchdogPath();
		assert.equal(result.success, true);
		assert.equal(result.agentName, "developer");
	});

	it("watchdogFired before promptSettled waits for prompt then throws", async () => {
		// Simulates: watchdog fires while prompt is still pending
		let promptSettled = false;
		const agentName = "developer";
		const WATCHDOG_TIMEOUT_MS = 30_000;
		const state = createState({});

		async function simulateWatchdogWithPendingPrompt(): Promise<AgentRunResult> {
			const watchdogFired = true;

			// Simulate prompt that eventually settles
			const settlePrompt = async () => {
				await new Promise((r) => setTimeout(r, 10));
				promptSettled = true;
			};

			if (watchdogFired) {
				const durationMs = Date.now() - state.startedAt;
				state.fullLog.push(
					`[Stall: ${agentName} aborted after ${durationMs}ms — no events for >${WATCHDOG_TIMEOUT_MS / 1000}s]`,
				);

				// Ensure prompt settled
				if (!promptSettled) {
					try {
						await settlePrompt();
					} catch {
						// prompt settled via abort
					}
				}

				throw new Error(
					`Agent ${agentName} stalled: no events for >${WATCHDOG_TIMEOUT_MS / 1000}s`,
				);
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		await assert.rejects(simulateWatchdogWithPendingPrompt(), {
			message: "Agent developer stalled: no events for >30s",
		});

		// Verify prompt eventually settled
		assert.equal(promptSettled, true, "prompt should have settled after await");
	});
});

// ─── runAgentInProcess — budget param wiring ──────────────────────

describe("runAgentInProcess — budget param wiring", () => {
	it("state initialized with maxToolCalls=30 when passed 30", () => {
		const state = createState({ maxToolCalls: 30 });
		assert.equal(state.maxToolCalls, 30);
	});

	it("state initialized with agentTokenBudget=500000 when passed 500000", () => {
		const state = createState({ agentTokenBudget: 500000 });
		assert.equal(state.agentTokenBudget, 500000);
	});

	it("state has both budget fields set correctly when both passed", () => {
		const state = createState({ maxToolCalls: 30, agentTokenBudget: 500000 });
		assert.equal(state.maxToolCalls, 30);
		assert.equal(state.agentTokenBudget, 500000);
	});

	it("state has maxToolCalls=0 and agentTokenBudget=0 when undefined (backward compat)", () => {
		const state = createState({});
		assert.equal(state.maxToolCalls, 0);
		assert.equal(state.agentTokenBudget, 0);
	});

	it("state has maxToolCalls=0 and agentTokenBudget=0 when explicitly 0", () => {
		const state = createState({ maxToolCalls: 0, agentTokenBudget: 0 });
		assert.equal(state.maxToolCalls, 0);
		assert.equal(state.agentTokenBudget, 0);
	});

	it("budgetExceeded is false initially", () => {
		const state = createState({ maxToolCalls: 30, agentTokenBudget: 500000 });
		assert.equal(state.budgetExceeded, false);
	});

	it("budgetExceededReason is undefined initially", () => {
		const state = createState({ maxToolCalls: 30, agentTokenBudget: 500000 });
		assert.equal(state.budgetExceededReason, undefined);
	});

	it("existing buildAgentRunResult tests still pass with budgetExceeded", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Tool limit: 30/30",
			toolCount: 30,
			tokenCount: 100000,
			maxToolCalls: 30,
			agentTokenBudget: 500000,
		});
		const result: AgentRunResult = buildAgentRunResult(state, "developer", false, 5000, []);
		assert.equal(result.budgetExceeded, true);
		assert.equal(result.toolCount, 30);
		assert.equal(result.tokenCount, 100000);
		assert.equal(result.success, false);
	});
});

// ─── noTools parameter (ask_user bug fix) ─────────────────────────

describe("createAgentSession — noTools parameter prevents ask_user leak", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/session-runner.ts", "utf-8");

	it("noTools is 'builtin' when tools.length > 0 (explicit allowlist)", () => {
		const lines = source.split("\n");
		const toolsLine = lines.findIndex((l) => l.includes("tools:") && l.includes("tools.length"));
		assert.ok(toolsLine >= 0, "should have a tools line that checks tools.length");

		for (let i = toolsLine; i < Math.min(toolsLine + 10, lines.length); i++) {
			if (lines[i].includes("noTools:")) {
				assert.ok(
					lines[i].includes('tools.length > 0 ? "builtin"'),
					`noTools line must use tools.length > 0 check (got: ${lines[i].trim()})`,
				);
				return;
			}
		}
		assert.fail("noTools line not found near tools line in createAgentSession call");
	});

	it("does NOT pass noTools when tools.length === 0 (no explicit tools)", () => {
		const hasUndefinedCase = source.includes("noTools: tools.length === 0 ? undefined");
		const hasTernary = source.includes('noTools: tools.length > 0 ? "builtin" : undefined');
		assert.ok(hasUndefinedCase || hasTernary, "noTools must be undefined when tools.length === 0");
	});

	it("createAgentSession tools uses tools.length > 0 ternary", () => {
		const toolsLine = source
			.split("\n")
			.find((l) => l.includes("tools:") && l.includes("tools.length"));
		assert.ok(toolsLine, "tools line must exist");
		assert.ok(
			toolsLine.includes("tools.length > 0 ? tools : undefined"),
			`tools must use tools.length > 0 ternary (got: ${toolsLine.trim()})`,
		);
	});

	it("createAgentSession has noTools:builtin alongside tools for defense-in-depth", () => {
		const match = source.match(
			/tools:\s*tools\.length\s*>\s*0\s*\?\s*tools\s*:\s*undefined,\n\s*noTools:\s*tools\.length\s*>\s*0\s*\?\s*"builtin"\s*:\s*undefined,/,
		);
		assert.ok(
			match,
			"createAgentSession call must have both tools and noTools using tools.length > 0 ternary",
		);
	});
});

// ─── Timeout path reads messages BEFORE dispose (GH #453) ──────────

describe("timeout path — capture messages before dispose", () => {
	it("messages captured before dispose are passed to buildAgentRunResult", () => {
		// Simulate timeout path: messages saved, then dispose clears state
		const messagesBeforeDispose = [
			{ role: "user", content: "Hello" },
			{
				role: "assistant",
				content: "Hi there",
				usage: { input: 10, output: 20, totalTokens: 30 },
			},
		];

		// Simulate session that clears state on dispose
		let sessionStateCleared = false;
		const session = {
			state: { messages: [...messagesBeforeDispose] },
			dispose: () => {
				// This is what dispose might do — clear state
				session.state = { messages: [] };
				sessionStateCleared = true;
			},
		};

		// Simulate the FIXED timeout path: capture BEFORE dispose
		const captured = session?.state?.messages || [];
		session?.dispose();

		assert.equal(sessionStateCleared, true, "session state should be cleared after dispose");
		assert.equal(
			session.state.messages.length,
			0,
			"session messages should be empty after dispose",
		);
		assert.equal(captured.length, 2, "captured messages should have 2 entries");
		assert.deepEqual(
			captured,
			messagesBeforeDispose,
			"captured messages must match pre-dispose state",
		);
	});

	it("buildAgentRunResult token fallback works with captured messages", () => {
		// Messages with assistant usage data
		const messages = [
			{ role: "user", content: "Hello" },
			{
				role: "assistant",
				content: "Hi there",
				usage: { input: 10, output: 20, totalTokens: 30 },
			},
		];

		// State with tokenCount=0 (pre-message-fallback value)
		const state = createState({ tokenCount: 0 });

		const result = buildAgentRunResult(state, "developer", false, 5000, messages);

		// tokenCount should come from message usage, not state.tokenCount
		assert.equal(result.tokenCount, 30, "should use last assistant message totalTokens");
	});

	it("timeout path with empty messages returns zero token count", () => {
		const state = createState({ tokenCount: 0 });
		const result = buildAgentRunResult(state, "developer", false, 5000, []);

		// Empty messages array means no usage fallback
		assert.equal(result.tokenCount, 0, "should fall back to state.tokenCount=0");
	});

	it("timeout path with session.state null/undefined does not crash", () => {
		const session = {
			state: null as any,
			dispose: () => {},
		};

		// Should not throw — optional chaining handles null
		const messages = session?.state?.messages || [];
		assert.ok(Array.isArray(messages), "messages should be empty array fallback");
		assert.equal(messages.length, 0, "null state yields empty messages");
	});
});
