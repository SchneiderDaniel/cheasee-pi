// ─── Tests: executeTool Interactive Dispatch ───────────────────────
// Tests that executeAgent() dispatches through executeTool with correct
// arguments and handles the result properly.
//
// executeAgent() has been refactored to:
// 1. Call pi.executeTool("subagent", {agent, task, cwd, maxToolCalls, agentTokenBudget}, {signal})
// 2. Convert result via convertToolResultToAgentRunResult
// 3. Validate result
// 4. Handle budget-exceeded (no retry) and failure (subprocess retry)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Create a minimal mock ExtensionCommandContext for tests.
 * Optional signal for testing signal passthrough.
 */
function createMockCtx(opts?: { hasSignal?: boolean }): ExtensionCommandContext {
	return {
		cwd: "/repo",
		signal: opts?.hasSignal ? new AbortController().signal : undefined,
		ui: {
			notify: (_msg: string, _type?: string) => {},
			setStatus: (_key: string, _status?: string) => {},
			confirm: async () => true,
			select: async () => "",
		},
	} as unknown as ExtensionCommandContext;
}

/**
 * Create a mock ExtensionAPI with call tracking for executeTool, sendMessage.
 * executeTool mock returns the configured result.
 */
function createMockPi(options?: {
	executeToolResult?: any;
	executeToolShouldThrow?: boolean;
}): ExtensionAPI & { executeToolCalls: any[]; sendMessageCalls: any[] } {
	const executeToolCalls: any[] = [];
	const sendMessageCalls: any[] = [];

	const mockPi = {
		executeTool: ((name: string, params: any, opts?: any) => {
			executeToolCalls.push({ name, params, opts });
			if (options?.executeToolShouldThrow) {
				return Promise.reject(new Error("executeTool mock error"));
			}
			return Promise.resolve(
				options?.executeToolResult ?? {
					content: [{ type: "text", text: "Success" }],
					details: {
						agentName: "test-agent",
						success: true,
						statusLabel: "SUCCESS",
						summaryLine: "Test agent completed",
						model: "test-model",
						inputTokens: 100,
						outputTokens: 50,
						cacheRead: 10,
						cacheWrite: 5,
						cost: 0.002,
						turnCount: 3,
						durationMs: 5000,
						toolCalls: [{ name: "read", args: { path: "test.ts" } }],
						toolResults: [{ name: "read", isError: false }],
						taskPrompt: "test task",
					},
				},
			);
		}) as any,
		sendMessage: ((msg: any) => {
			sendMessageCalls.push(msg);
		}) as any,
		exec: (() => Promise.resolve({ code: 0, stdout: "", stderr: "" })) as any,
		registerCommand: (() => {}) as any,
		registerTool: (() => {}) as any,
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI & { executeToolCalls: any[]; sendMessageCalls: any[] };

	mockPi.executeToolCalls = executeToolCalls;
	mockPi.sendMessageCalls = sendMessageCalls;
	return mockPi;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const mockAgent = {
	config: {
		name: "developer",
		model: "anthropic/claude-sonnet-4-20250514",
		description: "Test agent",
	},
	systemPrompt: "You are a test agent.",
};

// ─── Tests ─────────────────────────────────────────────────────────

describe("executeAgent() — executeTool dispatch (Phase 2)", () => {
	it("calls pi.executeTool with correct tool name 'subagent'", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx({ hasSignal: true });

		const { executeAgent } = await import("../pipeline/handler.ts");

		await executeAgent(mockAgent as any, "test task", ctx, pi, 30000, "/worktree/path", 50, 100000);

		assert.equal(pi.executeToolCalls.length, 1, "executeTool should be called once");
		assert.equal(pi.executeToolCalls[0].name, "subagent", "tool name should be 'subagent'");
	});

	it("passes agent, task, cwd, maxToolCalls, agentTokenBudget in params", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx({ hasSignal: true });

		const { executeAgent } = await import("../pipeline/handler.ts");

		await executeAgent(mockAgent as any, "test task", ctx, pi, 30000, "/worktree/path", 50, 100000);

		const params = pi.executeToolCalls[0].params;
		assert.equal(params.agent, "developer");
		assert.equal(params.task, "test task");
		assert.equal(params.cwd, "/worktree/path");
		assert.equal(params.maxToolCalls, 50);
		assert.equal(params.agentTokenBudget, 100000);
	});

	it("passes ctx.signal in options", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx({ hasSignal: true });
		const signal = ctx.signal;

		const { executeAgent } = await import("../pipeline/handler.ts");

		await executeAgent(mockAgent as any, "test task", ctx, pi, 30000, "/worktree/path", 50, 100000);

		const opts = pi.executeToolCalls[0].opts;
		assert.ok(opts, "options should be passed");
		assert.equal(opts.signal, signal, "signal should be ctx.signal");
	});

	it("sends start message before executeTool call", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();

		const { executeAgent } = await import("../pipeline/handler.ts");

		await executeAgent(mockAgent as any, "test task", ctx, pi, 30000, "/worktree/path");

		assert.ok(pi.sendMessageCalls.length >= 1, "sendMessage should be called");
		const startMsg = pi.sendMessageCalls[0];
		assert.equal(startMsg.customType, "supervisor");
		assert.ok(startMsg.content.includes("developer"), "start message should mention agent name");
	});

	it("converts executeTool result to AgentRunResult on success", async () => {
		const pi = createMockPi({
			executeToolResult: {
				content: [{ type: "text", text: "Agent output" }],
				details: {
					agentName: "developer",
					success: true,
					statusLabel: "SUCCESS",
					summaryLine: "Implemented feature X",
					model: "test-model",
					inputTokens: 100,
					outputTokens: 50,
					cacheRead: 10,
					cacheWrite: 5,
					cost: 0.002,
					turnCount: 3,
					durationMs: 5000,
					toolCalls: [{ name: "read", args: { path: "test.ts" } }],
					toolResults: [{ name: "read", isError: false }],
					taskPrompt: "test task",
				},
			},
		});
		const ctx = createMockCtx({ hasSignal: true });

		const { executeAgent } = await import("../pipeline/handler.ts");

		const { result, usedRetry } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree/path",
			50,
			100000,
		);

		assert.equal(result.success, true);
		assert.equal(result.agentName, "developer");
		assert.equal(result.toolCount, 1);
		assert.equal(result.durationMs, 5000);
		assert.equal(usedRetry, false);
	});

	it("returns usedRetry=false on success", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();

		const { executeAgent } = await import("../pipeline/handler.ts");

		const { result, usedRetry } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
		);

		assert.equal(result.success, true);
		assert.equal(usedRetry, false);
	});

	it("handles budgetExceeded: does not retry", async () => {
		const pi = createMockPi({
			executeToolResult: {
				content: [{ type: "text", text: "Budget exceeded" }],
				details: {
					agentName: "developer",
					success: false,
					statusLabel: "BUDGET_EXCEEDED",
					summaryLine: "Budget exceeded",
					model: "test-model",
					inputTokens: 100,
					outputTokens: 50,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.002,
					turnCount: 3,
					durationMs: 30000,
					toolCalls: [],
					toolResults: [],
					taskPrompt: "test task",
					budgetExceeded: true,
				},
			},
		});
		const ctx = createMockCtx();

		const { executeAgent } = await import("../pipeline/handler.ts");

		const { result, usedRetry } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
		);

		assert.equal(result.budgetExceeded, true);
		assert.equal(usedRetry, false, "should not retry when budget exceeded");
	});

	it("handles null/undefined agentCwd gracefully", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();

		const { executeAgent } = await import("../pipeline/handler.ts");

		const { result } = await executeAgent(mockAgent as any, "test task", ctx, pi, 30000, undefined);

		assert.equal(result.success, true);
		assert.equal(pi.executeToolCalls[0].params.cwd, undefined);
	});
});
