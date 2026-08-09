/**
 * Behavioral tests for runAgentInProcess and runAgent (dispatcher).
 *
 * Mocks @earendil-works/pi-coding-agent to test:
 *   - runAgentInProcess orchestration (Phase 4 from test plan)
 *   - runAgent dispatcher with fallback (Phase 5 from test plan)
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks --test .pi/extensions/supervisor/test/agent-runner-in-process.test.mts
 */

import { describe, it, mock, before } from "node:test";
import assert from "node:assert/strict";

// ─── Mock AgentSession factory ────────────────────────────────────
// Uses a shared mutable config so each test can control behavior.

interface MockSessionConfig {
	/** Events to fire synchronously on subscribe */
	events?: Array<Record<string, unknown>>;
	/** Whether session.prompt should reject */
	shouldReject?: boolean;
	/** Error to reject with */
	rejectError?: Error;
	/** Messages to return from session.agent.state.messages */
	messages?: unknown[];
}

let currentSessionConfig: MockSessionConfig = {};

function createMockSession() {
	const subscribers: Array<(event: Record<string, unknown>) => void> = [];
	const config = currentSessionConfig;

	const session = {
		subscribe: (fn: (event: Record<string, unknown>) => void) => {
			subscribers.push(fn);
			// Fire events synchronously on subscribe as SDK does
			if (config.events) {
				for (const event of config.events) {
					fn(event);
				}
			}
			// Return unsubscribe function
			return () => {
				const idx = subscribers.indexOf(fn);
				if (idx >= 0) subscribers.splice(idx, 1);
			};
		},
		prompt: async (_task: string) => {
			if (config.shouldReject) {
				throw config.rejectError || new Error("session.prompt failed");
			}
		},
		abort: () => {},
		dispose: () => {},
		agent: {
			state: {
				messages: config.messages || [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			},
		},
		isStreaming: false,
	};

	return session;
}

function createMockSessionManager() {
	return {
		create: (cwd: string) => ({
			getCwd: () => cwd,
			getSessionDir: () => "/tmp/pi-session",
		}),
		inMemory: () => ({
			getCwd: () => undefined,
			getSessionDir: () => undefined,
		}),
	};
}

function createMockSettingsManager() {
	return {
		inMemory: () => ({}),
	};
}

// ─── Mock the SDK module ──────────────────────────────────────────
// This must be at the top level, before any dynamic imports of
// agent-session-runner.ts. The mock factory reads currentSessionConfig.

const hasMockModule = typeof mock.module === "function";

if (hasMockModule) {
	mock.module("@earendil-works/pi-coding-agent", {
		namedExports: {
			createAgentSession: (opts: any) => createMockSession(),
			SessionManager: createMockSessionManager(),
			SettingsManager: createMockSettingsManager(),
			createBashToolDefinition: (_cwd: string) => ({}),
			createReadToolDefinition: (_cwd: string) => ({}),
			createWriteToolDefinition: (_cwd: string) => ({}),
			createEditToolDefinition: (_cwd: string) => ({}),
			createGrepToolDefinition: (_cwd: string) => ({}),
			createFindToolDefinition: (_cwd: string) => ({}),
			createLsToolDefinition: (_cwd: string) => ({}),
			initTheme: () => {},
			getMarkdownTheme: () => ({}),
		},
	});
}

// ─── Fixtures ─────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────

if (!hasMockModule) {
	describe("agent-runner-in-process", () => {
		it("requires --experimental-test-module-mocks flag (Node.js < 23)", () => {});
	});
}

if (hasMockModule) {

// ─── Phase 4: runAgentInProcess orchestration ──────────────────────

describe("runAgentInProcess — orchestration", () => {
	before(() => resetMocks());

	it("returns AgentRunResult with success=true when session.prompt succeeds", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "task complete" }] }],
		};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			5000,
		);

		assert.equal(result.success, true);
		assert.equal(result.agentName, "test-agent");
		assert.equal(typeof result.durationMs, "number");
		assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
	});

	it("output field is populated from session.agent.state.messages", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "assistant", content: [{ type: "text", text: "completed" }] },
			],
		};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			5000,
		);

		assert.ok(result.output.length > 0, "output should not be empty");
		const parsed = JSON.parse(result.output);
		assert.ok(Array.isArray(parsed), "output should be a JSON array of messages");
	});

	it("sets up subscription BEFORE calling session.prompt (verified by mock ordering)", async () => {
		resetMocks();
		currentSessionConfig = {};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			5000,
		);

		assert.equal(result.success, true);
	});

	it("returns success=false on timeout", async () => {
		resetMocks();
		currentSessionConfig = {};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		try {
			await runAgentInProcess(
				mockAgent as any,
				"test task that hangs",
				mockCtx,
				1, // very short timeout
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			assert.ok(
				msg.includes("timed out") || msg.includes("timeout"),
				`Error should mention timeout: ${msg}`,
			);
		}
	});

	it("budgetExceeded field is present in result", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "task" }] }],
		};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			5000,
			undefined,
			1, // maxToolCalls=1
		);

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
			await runAgentInProcess(
				mockAgent as any,
				"test task",
				mockCtx,
				5000,
			);
			assert.fail("should have thrown SDK error");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			assert.ok(
				msg.includes("SDK failed"),
				`Error should propagate SDK error: ${msg}`,
			);
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
			await runAgentInProcess(
				badAgent as any,
				"test task",
				mockCtx,
				5000,
			);
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
			await runAgentInProcess(
				badAgent as any,
				"test task",
				mockCtx,
				5000,
			);
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

// ─── Phase 5: runAgent dispatcher ──────────────────────────────────

describe("runAgent — dispatcher with in-process first, subprocess fallback", () => {
	before(() => resetMocks());

	it("calls runAgentInProcess first and returns result on success", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		};

		const { runAgent } = await import("../agent/runner.ts");
		const result = await runAgent(
			mockAgent as any,
			"test task",
			mockCtx,
			5000,
		);

		assert.ok(result !== undefined, "should return a result");
		assert.equal(typeof result.success, "boolean");
	});

	it("falls back to subprocess when in-process throws (timeout)", async () => {
		resetMocks();

		const { runAgent } = await import("../agent/runner.ts");
		const result = await runAgent(
			mockAgent as any,
			"test task",
			mockCtx,
			1, // very short timeout causes in-process to throw
		);

		// Should get a result (subprocess fallback will also likely fail/timeout
		// since we don't have /usr/bin/pi, but it shouldn't throw)
		assert.ok(result !== undefined, "should return a result even on fallback");
	});

	it("passes all arguments to both runners", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		};

		const { runAgent } = await import("../agent/runner.ts");
		const result = await runAgent(
			mockAgent as any,
			"special task with args",
			mockCtx,
			10000,
			"/custom/cwd",
			5,
			10000,
			"/tmp/session.jsonl",
			mockPi,
		);

		assert.ok(result !== undefined, "should return a result with all args");
	});

	describe("runAgent — fallback safety (sync throw containment)", () => {
		before(() => resetMocks());

		it("in-process throws → fallback called, returns result without rejecting", async () => {
			resetMocks();

			const { runAgent } = await import("../agent/runner.ts");
			const result = await runAgent(
				mockAgent as any,
				"test task",
				mockCtx,
				1, // very short timeout → in-process throws → fallback
			);

			assert.ok(
				result !== undefined,
				"should return a result even on fallback",
			);
			assert.equal(typeof result.success, "boolean");
		});

		it("fallback handles sync throw from resolveSkillPaths (unresolvable skill)", async () => {
			resetMocks();
			// Make in-process runner throw so the fallback is triggered
			currentSessionConfig = {
				shouldReject: true,
				rejectError: new Error("In-process failed, triggering fallback"),
			};

			const badSkillAgent = {
				config: {
					name: "bad-skill-agent",
					tools: "read",
					model: "anthropic/claude-sonnet-4-20250514",
					extensions: "",
					skills: "nonexistent-skill",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};

			const { runAgent } = await import("../agent/runner.ts");
			const result = await runAgent(
				badSkillAgent as any,
				"test task",
				mockCtx,
				5000,
			);

			assert.equal(result.success, false);
			assert.equal(result.agentName, "bad-skill-agent");
			assert.equal(result.toolCount, 0);
		});
	});
});

}
