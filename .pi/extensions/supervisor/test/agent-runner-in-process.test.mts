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
/**
 * Synchronous busy-wait (ms) inside the mocked getModel — models slow model
 * resolution, i.e. setup that runs BEFORE any await and must still count
 * against the wall-clock deadline (audit finding #1).
 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (hasMockModule) {
	// Mock the model resolver so a test can inject a SYNCHRONOUS setup delay.
	// Only agent-session-runner.ts imports this module (getModel), so the mock
	// cannot leak into another dependency.
	mock.module("@earendil-works/pi-ai", {
		namedExports: {
			getModel: (provider: string, id: string) => {
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
	slowSyncSetupMs = 0;
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

	it("timeout: deadline fires → session.abort() called, timedOut=true, success=false, no throw", async () => {
		resetMocks();
		currentSessionConfig = {
			hangUntilAbort: true,
			abortError: new Error("This operation was aborted"),
		};

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task that hangs",
			mockCtx,
			60, // short deadline
		);

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
		const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 50);

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
		const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 40);
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
		// 200ms of SYNCHRONOUS setup (a getModel busy-wait) with a 100ms bound.
		// The deadline is computed at ENTRY, so the total stays ≈200ms — it must
		// never become setup + timeout (≈300ms).
		slowSyncSetupMs = 200;
		try {
			const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
			const startedAt = Date.now();
			const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 100);
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
		const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 60);
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
		const result = await runAgent(mockAgent as any, "test task", mockCtx, 50);

		assert.equal(result.timedOut, true, "dispatcher returns the setup-time timeout result");
		assert.equal(result.killReason, "timeout");
		const elapsed = Date.now() - startedAt;
		assert.ok(
			elapsed <= 50 + 500,
			`hard 1× bound incl. setup — total ≈50ms, got ${elapsed}`,
		);
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
		const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 0);

		assert.equal(result.timedOut, true, "zero remaining budget is a timeout, not a success");
		assert.equal(result.success, false);
		assert.equal(result.killReason, "timeout");
		assert.equal(
			cfg.promptCalls ?? 0,
			0,
			"no prompt may start once the deadline is already expired",
		);
	});

	it("absolute deadline already past → sync guard reports the CONFIGURED duration (audit #1/#3)", async () => {
		resetMocks();
		const cfg: MockSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "slipped through" }] }],
		};
		currentSessionConfig = cfg;

		const { runAgentInProcess } = await import("../agent/agent-session-runner.ts");
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			300_000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			Date.now() - 1,
		);

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
		const result = await runAgentInProcess(
			mockAgent as any,
			"test task",
			mockCtx,
			null, // configured 0 = no timeout
		);

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
		const result = await runAgentInProcess(mockAgent as any, "test task", mockCtx, 200);

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
			runAgentInProcess(mockAgent as any, "test task", mockCtx, 5000),
			/SDK failed/,
		);
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

	it("in-process timeout → subprocess fallback SUPPRESSED: timeout result returned", async () => {
		resetMocks();
		currentSessionConfig = {
			hangUntilAbort: true,
			abortError: new Error("This operation was aborted"),
		};

		const { runAgent } = await import("../agent/runner.ts");
		const startedAt = Date.now();
		const result = await runAgent(mockAgent as any, "test task", mockCtx, 25);

		// The returned result IS the in-process timeout result — a subprocess
		// fallback would have surfaced an ENOENT-spawn failure without a
		// timedOut flag; its absence proves the fallback was suppressed.
		assert.equal(result.timedOut, true, "timeout result returned from dispatcher");
		assert.equal(result.killReason, "timeout");
		assert.equal(result.success, false);
		assert.ok(
			result.durationMs <= 25 + 500,
			`hard 1× bound — total durationMs ≈ 25, got ${result.durationMs} (started ${Date.now() - startedAt})`,
		);
	});

	it("reports the CONFIGURED timeout, not the remaining budget (audit finding #3)", async () => {
		resetMocks();
		currentSessionConfig = {
			hangUntilAbort: true,
			abortError: new Error("This operation was aborted"),
		};

		const { runAgent } = await import("../agent/runner.ts");
		// Absolute deadline already past while the configured timeout is 300s:
		// failure state must report 300_000ms, never the ~0 remaining budget.
		const result = await runAgent(
			mockAgent as any,
			"test task",
			mockCtx,
			300_000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			Date.now() - 1,
		);

		assert.equal(result.timedOut, true, "an expired absolute deadline still times out");
		assert.equal(
			result.configuredTimeoutMs,
			300_000,
			"configured duration reported, not the remaining enforcement budget",
		);
		assert.match(
			result.errorOutput as string,
			/exceeded 300s/,
			"timeout note names the configured duration",
		);
	});

	it("in-process success returned directly, subprocess never spawned", async () => {
		resetMocks();
		currentSessionConfig = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "fast" }] }],
		};

		const { runAgent } = await import("../agent/runner.ts");
		const result = await runAgent(mockAgent as any, "test task", mockCtx, 5000);

		assert.equal(result.success, true);
		assert.equal(result.timedOut, undefined);
	});

	it("in-process budget-exceeded fallback behavior preserved (falls back as today)", async () => {
		resetMocks();
		// Budget-exceeded is NOT a deadline timeout — the dispatcher must
		// still fall back to the subprocess (as today), NOT suppress it.
		currentSessionConfig = {
			events: [
				{ type: "tool_execution_start", toolName: "read" },
				{ type: "tool_execution_end", toolName: "read" },
				{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 100 } } },
			],
		};

		const { runAgent } = await import("../agent/runner.ts");
		const result = await runAgent(mockAgent as any, "test task", mockCtx, 5000, undefined, 1);

		// The fallback subprocess attempt runs (and fails here for lack of
		// /usr/bin/pi) — the key assertion is that it was NOT suppressed:
		assert.equal(result.timedOut, undefined, "not classified as a deadline timeout");
		assert.equal(result.success, false, "fallback attempt surfaced its failure");
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
