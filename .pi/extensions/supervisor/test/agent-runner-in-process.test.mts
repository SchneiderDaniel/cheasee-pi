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

if (!hasMockModule) {
	describe("agent-runner-in-process", () => {
		it("requires --experimental-test-module-mocks flag (Node.js < 23)", () => {});
	});
}
if (hasMockModule) {
	describe("runAgentInProcess — orchestration", () => {
		before(() => resetMocks());
		it("returns AgentRunResult with success=true when session.prompt succeeds", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "task complete" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

			assert.equal(result.success, true);
			assert.equal(result.agentName, "test-agent");
			assert.equal(typeof result.durationMs, "number");
			assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
		});
		it("reports the agent's thinkingLevel (matches subprocess result shape)", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

			// mockAgent.config.thinking === "medium" — the state-derived field must
			// reach the result exactly as it does on the subprocess path.
			assert.equal(result.thinkingLevel, "medium");
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
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

			assert.ok(result.output.length > 0, "output should not be empty");
			const parsed = JSON.parse(result.output);
			assert.ok(Array.isArray(parsed), "output should be a JSON array of messages");
		});
		it("sets up subscription BEFORE calling session.prompt (verified by mock ordering)", async () => {
			resetMocks();
			currentSessionConfig = {};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

			assert.equal(result.success, true);
		});
		it("timeout: deadline fires → session.abort() called, timedOut=true, success=false, no throw", async () => {
			resetMocks();
			currentSessionConfig = {
				hangUntilAbort: true,
				abortError: new Error("This operation was aborted"),
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task that hangs",
				ctx: mockCtx,
				timeoutMs: 60,
			});

			// No throw on the timeout path — the dispatcher must not fall back
			// to a subprocess after the deadline fired (hard 1× bound).
			assert.equal(result.success, false, "timeout run is a failure");
			assert.equal(result.timedOut, true, "timedOut flag recorded");
			assert.equal(result.killReason, "timeout");
			assert.equal(result.configuredTimeoutMs, 60);
			assert.equal(currentSessionConfig.abortCalled, true, "session.abort() called on deadline");
			assert.match(
				result.errorOutput,
				/\[Timeout: test-agent exceeded 0s \(actual \d+ms\)\]/,
				"timeout note authored into errorOutput (pipeline state retains it)",
			);
			// durationMs ≈ full wall-clock bound (hard 1×, not near-zero):
			// allow sub-ms clock-quantization slack on the fired timer.
			assert.ok(result.durationMs >= 55, `durationMs ≈ bound, got ${result.durationMs}`);
		});
		it("deadline covers SETUP: slow createAgentSession still bounded (audit finding #2)", async () => {
			resetMocks();
			// Session creation takes 200ms — far past the 50ms deadline. The
			// timer is armed at runner ENTRY (before SDK load / session
			// creation), so setup must NOT be excluded from the wall-clock bound.
			currentSessionConfig = {
				setupDelayMs: 200,
				messages: [{ role: "assistant", content: [{ type: "text", text: "never reached" }] }],
			};

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const startedAt = Date.now();
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 50,
			});

			assert.equal(result.timedOut, true, "setup starvation still times out");
			assert.equal(result.success, false);
			const elapsed = Date.now() - startedAt;
			assert.ok(
				elapsed <= 50 + 300,
				`setup counted against the bound — total ≈50ms, got ${elapsed}`,
			);
			assert.ok(
				elapsed >= 40,
				`deadline fired at ≈50ms rather than after the 200ms setup, got ${elapsed}`,
			);
		});
		it("deadline fires during setup → late session is disposed, NO prompt starts (audit finding #2)", async () => {
			resetMocks();
			// createAgentSession resolves 200ms after the 40ms deadline. The
			// setup body must not resume into subscribe/prompt after the timeout,
			// and the session that materializes late must be disposed — otherwise
			// provider/session work leaks with no watchdog.
			const cfg: MockSessionConfig = {
				setupDelayMs: 200,
				messages: [{ role: "assistant", content: [{ type: "text", text: "never reached" }] }],
			};
			currentSessionConfig = cfg;

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 40,
			});
			assert.equal(result.timedOut, true, "setup hang is bounded by the deadline");

			// Let the delayed session creation resolve after the timeout.
			await sleep(250);
			assert.equal(cfg.promptCalls ?? 0, 0, "no prompt may start after the deadline fired");
			assert.equal(cfg.disposeCalled, true, "session created after the deadline was disposed");
		});
		it("deadline armed BEFORE sync setup: slow model resolution cannot extend the bound (audit #1)", async () => {
			resetMocks();
			currentSessionConfig = {
				hangUntilAbort: true,
				abortError: new Error("This operation was aborted"),
			};
			// 200ms of SYNCHRONOUS setup (a getBuiltinModel busy-wait) with a 100ms bound.
			// The deadline is computed at ENTRY, so the total stays ≈200ms — it must
			// never become setup + timeout (≈300ms).
			slowSyncSetupMs = 200;
			try {
				const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
				const startedAt = Date.now();
				const result = await runAgentInProcess({
					agent: mockAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 100,
				});
				const elapsed = Date.now() - startedAt;

				assert.equal(result.timedOut, true, "sync setup past the deadline still times out");
				assert.equal(result.configuredTimeoutMs, 100, "configured duration reported");
				assert.ok(elapsed >= 200, `sync setup actually ran, got ${elapsed}ms`);
				assert.ok(
					elapsed < 200 + 100 - 15,
					`bound NOT extended by sync setup: expected ≈200ms, got ${elapsed}ms`,
				);
			} finally {
				slowSyncSetupMs = 0;
			}
		});
		it("never-settling session setup is bounded; no prompt starts, no background session (audit #2)", async () => {
			resetMocks();
			const cfg: MockSessionConfig = { setupNeverSettles: true };
			currentSessionConfig = cfg;

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const startedAt = Date.now();
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 60,
			});
			const elapsed = Date.now() - startedAt;

			assert.equal(result.timedOut, true, "never-settling setup bounded by the deadline");
			assert.equal(result.success, false);
			assert.equal(result.configuredTimeoutMs, 60);
			assert.ok(elapsed < 60 + 300, `bounded ≈60ms, got ${elapsed}ms`);

			// Give a late-resolving setup every chance to start provider work.
			await sleep(40);
			assert.equal(cfg.promptCalls ?? 0, 0, "no prompt started after the deadline");
		});
		it("deadline covers SETUP via dispatcher: runAgent passes the remaining dispatch deadline", async () => {
			resetMocks();
			// Same slow-setup scenario through runAgent: the dispatcher must pass
			// the REMAINING time from the absolute dispatch deadline so the
			// in-process watchdog covers setup, and the timeout result must be
			// returned without a subprocess fallback (hard 1× bound).
			currentSessionConfig = {
				setupDelayMs: 200,
				messages: [{ role: "assistant", content: [{ type: "text", text: "never reached" }] }],
			};

			const { runAgent } = await import("../agent/runner.ts");
			const startedAt = Date.now();
			const result = await runAgent({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 50,
			});

			assert.equal(result.timedOut, true, "dispatcher returns the setup-time timeout result");
			assert.equal(result.killReason, "timeout");
			const elapsed = Date.now() - startedAt;
			assert.ok(elapsed <= 50 + 500, `hard 1× bound incl. setup — total ≈50ms, got ${elapsed}`);
		});
		it("already-expired deadline is caught synchronously before prompt (audit finding #1)", async () => {
			resetMocks();
			// Cached SDK + an immediately-resolving prompt: every promise settles
			// through microtasks BEFORE the 0ms deadline timer runs. The synchronous
			// `Date.now()` guard must still classify the run as a timeout and never
			// start the prompt (old code returned success=true here).
			const cfg: MockSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "slipped through" }] }],
			};
			currentSessionConfig = cfg;

			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const result = await runAgentInProcess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 0,
			});

			assert.equal(result.timedOut, true, "zero remaining budget is a timeout, not a success");
			assert.equal(result.success, false);
			assert.equal(result.killReason, "timeout");
			assert.equal(
				cfg.promptCalls ?? 0,
				0,
				"no prompt may start once the deadline is already expired",
			);
		});
	});
}
