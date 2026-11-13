import { describe, it, mock, before } from "node:test";

import assert from "node:assert/strict";

import {
	createCodingAgentMockExports,
	createProviderMockExports,
	type MockSessionConfig,
} from "./helpers/mock-agent-session.ts";

let currentSessionConfig: MockSessionConfig = {};

const hasMockModule = typeof mock.module === "function";

if (hasMockModule) {
	// Registration stays here: module mocks are per-process and must be
	// installed before the runner import below. The factory only builds the
	// export objects, reading `currentSessionConfig` at call time.
	mock.module("@earendil-works/pi-ai/providers/all", {
		namedExports: createProviderMockExports(() => currentSessionConfig),
	});

	mock.module("@earendil-works/pi-coding-agent", {
		namedExports: createCodingAgentMockExports(() => currentSessionConfig),
	});
}

const mockAgent = {
	config: {
		name: "test-agent",
		tools: "read,bash,write,edit",
		model: "anthropic/claude-sonnet-4-20250514",
		extensions: "",
		skills: "",
		thinking: "medium",
	},
	systemPrompt: "You are a test agent.",
};

const mockCtx: any = {
	cwd: "/tmp",
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: mock.fn(),
		setWorkingMessage: mock.fn(),
	},
};

const mockPi: any = {
	sendMessage: mock.fn(),
};

function resetMocks(): void {
	currentSessionConfig = {};
	(mockCtx.ui.setWidget as any).mock.resetCalls?.();
	(mockCtx.ui.setWorkingMessage as any).mock.resetCalls?.();
	(mockPi.sendMessage as any).mock.resetCalls?.();
}

if (hasMockModule) {
	describe("runAgentInProcess — orchestration", () => {
		before(() => resetMocks());
		it("absolute deadline already past → sync guard reports the CONFIGURED duration (audit #1/#3)", async () => {
			resetMocks();
			const cfg: MockSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "slipped through" }] }],
			};
			currentSessionConfig = cfg;

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 300_000,
				deadlineMs: Date.now() - 1,
			});

			assert.equal(result.timedOut, true, "an expired absolute deadline still times out");
			assert.equal(
				result.configuredTimeoutMs,
				300_000,
				"configured duration reported, not the remaining enforcement budget",
			);
			assert.equal(cfg.promptCalls ?? 0, 0, "no prompt after the absolute deadline passed");
		});
		it("timeoutMs=null → no abort timer, prompt completes → success", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: null,
			});

			assert.equal(result.success, true);
			assert.equal(result.timedOut, undefined, "no timeout state for unbounded run");
			assert.equal(currentSessionConfig.abortCalled, undefined, "no abort for unbounded run");
		});
		it("prompt resolves before deadline → success, abort listener removed (no late abort)", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "fast" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 200,
			});

			assert.equal(result.success, true, "prompt won the race against a 200ms deadline");
			assert.equal(currentSessionConfig.abortCalled, undefined, "no late abort after completion");
		});
		it("non-timeout SDK error still throws → dispatcher fallback preserved", async () => {
			resetMocks();
			currentSessionConfig = {
				shouldReject: true,
				rejectError: new Error("SDK failed: model overloaded"),
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			await assert.rejects(
				runAgentInProcess({
					agent: mockAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				}),
				/SDK failed/,
			);
		});
		it("budgetExceeded field is present in result", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "task" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

			assert.ok("budgetExceeded" in result, "result should have budgetExceeded field");
		});
		it("propagates SDK errors to caller for fallback", async () => {
			resetMocks();
			currentSessionConfig = {
				shouldReject: true,
				rejectError: new Error("SDK failed: model overloaded"),
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			try {
				await runAgentInProcess({
					agent: mockAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				});
				assert.fail("should have thrown SDK error");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				assert.ok(msg.includes("SDK failed"), `Error should propagate SDK error: ${msg}`);
			}
		});
		it("model resolution failure throws before createAgentSession", async () => {
			resetMocks();
			const badAgent = {
				config: {
					name: "bad-agent",
					tools: "read",
					model: "nonexistent/provider-id",
					extensions: "",
					skills: "",
					thinking: "",
				},
				systemPrompt: "You are a test.",
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			try {
				await runAgentInProcess({
					agent: badAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				});
				assert.fail("should have thrown model resolution error");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				assert.ok(
					msg.includes("nonexistent/provider-id") || msg.includes("could not be resolved"),
					`Error should mention the model string: ${msg}`,
				);
			}
		});
		it("handles model config being empty string by throwing", async () => {
			resetMocks();
			const badAgent = {
				config: {
					name: "no-model-agent",
					tools: "read",
					model: "",
					extensions: "",
					skills: "",
					thinking: "",
				},
				systemPrompt: "You are a test.",
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			try {
				await runAgentInProcess({
					agent: badAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				});
				assert.fail("should have thrown for empty model");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				assert.ok(
					msg.includes("no model configured") || msg.includes('""') || msg.includes("undefined"),
					`Error should mention empty model: ${msg}`,
				);
			}
		});
	});
}
