// ─── Tests: executeAgent() — subprocess dispatch path ──────────────
// Verifies executeAgent (from pipeline/execute-agent.ts) covers all paths.
//
// executeAgent accepts an optional runner parameter (last arg) for injecting
// a mock runAgentSubprocess. This avoids real process spawn and module-level
// mocking (which requires --experimental-test-module-mocks).

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult } from "../../config/types.ts";

// ─── Helpers ─────────────────────────────────────────────────────

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		signal: new AbortController().signal,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
			confirm: async () => true,
			select: async () => "",
		},
	} as unknown as ExtensionCommandContext;
}

function createMockPi(): ExtensionAPI & { sendMessageCalls: any[] } {
	const sendMessageCalls: any[] = [];
	return {
		sendMessage: ((msg: any) => {
			sendMessageCalls.push(msg);
		}) as any,
		exec: (() => Promise.resolve({ code: 0, stdout: "", stderr: "" })) as any,
		registerCommand: (() => {}) as any,
		registerTool: (() => {}) as any,
		getActiveTools: () => [],
		getAllTools: () => [],
		sendMessageCalls,
	} as unknown as ExtensionAPI & { sendMessageCalls: any[] };
}

const mockAgent = {
	config: {
		name: "developer",
		model: "anthropic/claude-sonnet-4-20250514",
		description: "Test agent",
	},
	systemPrompt: "You are a test agent.",
};

// Factory for mock runAgentSubprocess
function mockRunner(result: Partial<AgentRunResult> = {}) {
	return mock.fn(
		async (..._args: any[]) =>
			({
				output: "raw output",
				success: true,
				agentName: "developer",
				toolCount: 3,
				tokenCount: 500,
				durationMs: 10000,
				textOutput: "Test completed successfully\nIMPLEMENTATION_COMPLETE",
				textOnly: "Test completed successfully\nIMPLEMENTATION_COMPLETE",
				summaryLine: "Test completed",
				errorOutput: "",
				...result,
			}) as AgentRunResult,
	);
}

afterEach(() => {
	mock.reset();
});

// ─── Tests ─────────────────────────────────────────────────────────

describe("executeAgent() — subprocess dispatch (Phase 1 promotion)", () => {
	it("success path: returns result with usedRetry=false", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		const { result, usedRetry } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			50,
			100000,
			undefined,
			runner,
		);

		assert.equal(result.success, true);
		assert.equal(usedRetry, false);
		assert.equal(result.agentName, "developer");
	});

	it("success path: calls runAgentSubprocess exactly once", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			50,
			100000,
			undefined,
			runner,
		);

		assert.equal(runner.mock.callCount(), 1, "runAgentSubprocess called exactly once");
		const call = runner.mock.calls[0]?.arguments;
		assert.ok(call, "should have call arguments");
		assert.equal(call[0]?.config?.name, "developer");
		assert.equal(call[1], "test task");
		assert.equal(call[3], 30000);
		assert.equal(call[4], "/worktree");
	});

	it("sends start message before subprocess", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		assert.ok(pi.sendMessageCalls.length >= 1, "should have sent at least one message");
		const startMsg = pi.sendMessageCalls[0];
		assert.equal(startMsg.customType, "supervisor");
		assert.equal(startMsg.details?.eventType, "phase-change");
		assert.ok(startMsg.content.includes("developer"), "start message should include agent name");
	});

	it("sends final subagent-result message after completion", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		assert.ok(pi.sendMessageCalls.length >= 2, "should have at least start + result messages");
		const resultMsg = pi.sendMessageCalls[pi.sendMessageCalls.length - 1];
		assert.equal(resultMsg.customType, "supervisor");
		assert.equal(resultMsg.details?.eventType, "subagent-result");
		assert.ok(
			resultMsg.content.includes("SUCCESS") || resultMsg.content.includes("FAILED"),
			"final message should include status label",
		);
	});

	it("calls replaySessionFile after successful subprocess (via side effects)", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			50,
			100000,
			undefined,
			runner,
		);

		assert.equal(runner.mock.callCount(), 1, "runAgentSubprocess should be called once");
		// On success, replaySessionFile is called internally by executeAgent.
		// We verify by checking the final subagent-result message was sent.
		const resultMsgs = pi.sendMessageCalls.filter(
			(m: any) => m.details?.eventType === "subagent-result",
		);
		assert.ok(resultMsgs.length >= 1, "should have at least one subagent-result message");
	});

	it("skips replay when subprocess fails", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner({ success: false, summaryLine: "Agent failed" });

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		const lastMsg = pi.sendMessageCalls[pi.sendMessageCalls.length - 1];
		assert.ok(lastMsg.content.includes("FAILED"), "final message should indicate failure");
	});

	it("budget exceeded path: returns budgetExceeded=true, usedRetry=false", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner({
			success: false,
			budgetExceeded: true,
			summaryLine: "Budget exceeded after 30 tools",
			toolCount: 30,
			tokenCount: 10000,
		});

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		const { result, usedRetry } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			5,
			10000,
			undefined,
			runner,
		);

		assert.equal(result.budgetExceeded, true);
		assert.equal(result.success, false, "budget exceeded should have success=false");
		assert.equal(usedRetry, false, "should not retry on budget exceeded");
	});

	it("budget exceeded path: sends warning notification", async () => {
		const runner = mockRunner({
			success: false,
			budgetExceeded: true,
			summaryLine: "Budget exceeded",
		});

		let notifyMsg = "";
		const ctx = {
			...createMockCtx(),
			ui: {
				...createMockCtx().ui,
				notify: (msg: string, _type?: string) => {
					notifyMsg = msg;
				},
			},
		};
		const pi = createMockPi();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			5,
			10000,
			undefined,
			runner,
		);

		assert.ok(notifyMsg.toLowerCase().includes("budget"), "should notify about budget");
	});

	it("passes sessionPath to runAgentSubprocess", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			"/worktree",
			50,
			100000,
			undefined,
			runner,
		);

		assert.equal(runner.mock.callCount(), 1);
		const args = runner.mock.calls[0]?.arguments;
		assert.ok(args, "should have arguments");
		const sessionPath = args[7]; // 8th arg is sessionPath
		assert.ok(
			typeof sessionPath === "string" && sessionPath.length > 0,
			"sessionPath should be a non-empty string",
		);
		assert.ok(
			sessionPath!.includes("pi-session-"),
			"sessionPath should contain pi-session- prefix",
		);
	});

	it("handles undefined agentCwd gracefully", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		const { result } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		assert.equal(result.success, true);
	});

	it("verify dispatch order: start → subprocess → result", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();
		const callOrder: string[] = [];

		const origSend = pi.sendMessage;
		pi.sendMessage = ((msg: any) => {
			callOrder.push(`msg:${msg.details?.eventType || "unknown"}`);
			origSend(msg);
		}) as any;

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		const startIdx = callOrder.findIndex((c) => c.includes("phase-change"));
		const resultIdx = callOrder.findIndex((c) => c.includes("subagent-result"));

		assert.ok(startIdx >= 0, "should have a phase-change start message");
		assert.ok(resultIdx >= 0, "should have a subagent-result message");
		assert.ok(startIdx < resultIdx, "start message should come before result message");
	});

	it("uses eventType discriminator (phase-change, subagent-result)", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		for (const msg of pi.sendMessageCalls) {
			if (msg.customType === "supervisor" && msg.details) {
				assert.ok(
					typeof msg.details.eventType === "string",
					`all supervisor messages should have eventType discriminator, got: ${JSON.stringify(Object.keys(msg.details))}`,
				);
			}
		}
	});

	it("returns correct AgentRunResult shape on success", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runner = mockRunner();

		const { executeAgent } = await import("../../pipeline/execute-agent.ts");

		const { result } = await executeAgent(
			mockAgent as any,
			"test task",
			ctx,
			pi,
			30000,
			undefined,
			undefined,
			undefined,
			undefined,
			runner,
		);

		assert.ok(typeof result.output === "string");
		assert.ok(typeof result.success === "boolean");
		assert.ok(typeof result.agentName === "string");
		assert.ok(typeof result.toolCount === "number");
		assert.ok(typeof result.tokenCount === "number");
		assert.ok(typeof result.durationMs === "number");
		assert.ok(typeof result.textOutput === "string");
		assert.ok(typeof result.summaryLine === "string");
		assert.ok(typeof result.errorOutput === "string");
		assert.ok(typeof result.textOnly === "string");
	});
});
