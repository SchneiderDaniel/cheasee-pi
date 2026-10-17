import { describe, it, mock, before } from "node:test";

import assert from "node:assert/strict";

interface MockSessionConfig {
	/** Events to fire synchronously on subscribe */
	events?: Array<Record<string, unknown>>;
	/** Whether session.prompt should reject */
	shouldReject?: boolean;
	/** Error to reject with */
	rejectError?: Error;
	/** Messages to return from session.agent.state.messages */
	messages?: unknown[];
	/** Prompt stays pending until session.abort() rejects it (deadline test). */
	hangUntilAbort?: boolean;
	/** Error the hung prompt rejects with on abort. */
	abortError?: Error;
	/** Set by the mock when session.abort() runs. */
	abortCalled?: boolean;
	/** Set by the mock when session.dispose() runs. */
	disposeCalled?: boolean;
	/** Count of session.prompt() invocations (must stay 0 after a deadline). */
	promptCalls?: number;
	/**
	 * Delay (ms) before createAgentSession resolves — models SDK setup
	 * (model resolution / SDK load / session creation) that must count
	 * against the wall-clock bound (audit finding #2).
	 */
	setupDelayMs?: number;
	/**
	 * createAgentSession never settles — models a provider/SDK setup hang that
	 * must be bounded by the deadline, leaving no background session work.
	 */
	setupNeverSettles?: boolean;
}

let currentSessionConfig: MockSessionConfig = {};

let slowSyncSetupMs = 0;

function createMockSession() {
	const subscribers: Array<(event: Record<string, unknown>) => void> = [];
	const config = currentSessionConfig;
	let pendingReject: ((err: Error) => void) | null = null;

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
			config.promptCalls = (config.promptCalls ?? 0) + 1;
			if (config.shouldReject) {
				throw config.rejectError || new Error("session.prompt failed");
			}
			if (config.hangUntilAbort) {
				// Stay pending until abort() rejects us — models an SDK session
				// blocked on a slow model after a tool result.
				await new Promise<never>((_resolve, reject) => {
					pendingReject = reject;
				});
			}
		},
		abort: () => {
			config.abortCalled = true;
			if (config.hangUntilAbort) {
				pendingReject?.(config.abortError || new Error("This operation was aborted"));
			}
		},
		dispose: () => {
			config.disposeCalled = true;
		},
		agent: {
			state: {
				messages: config.messages || [
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				],
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

const hasMockModule = typeof mock.module === "function";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (hasMockModule) {
	// Mock the model resolver so a test can inject a SYNCHRONOUS setup delay.
	// agent-session-runner.ts imports getBuiltinModel from this subpath, so the
	// mock must target "@earendil-works/pi-ai/providers/all" (the bare package
	// export is not what the runner consumes).
	mock.module("@earendil-works/pi-ai/providers/all", {
		namedExports: {
			getBuiltinModel: (provider: string, id: string) => {
				if (slowSyncSetupMs > 0) {
					const end = Date.now() + slowSyncSetupMs;
					while (Date.now() < end) {
						/* synchronous busy-wait: models slow setup before any await */
					}
				}
				if (provider !== "anthropic") {
					throw new Error(`unknown provider ${provider}`);
				}
				return { id, provider, api: "anthropic-messages" };
			},
		},
	});

	mock.module("@earendil-works/pi-coding-agent", {
		namedExports: {
			createAgentSession: async (opts: any) => {
				// A setup that never settles models a provider/SDK hang: the
				// dispatch must still return at the deadline with no prompt started.
				if (currentSessionConfig.setupNeverSettles) {
					await new Promise<never>(() => {});
				}
				// Setup delay models SDK session creation time — must count
				// against the wall-clock deadline armed at runner entry.
				if (currentSessionConfig.setupDelayMs) {
					await sleep(currentSessionConfig.setupDelayMs);
				}
				return createMockSession();
			},
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
	slowSyncSetupMs = 0;
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
