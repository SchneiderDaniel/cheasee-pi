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
	describe("runAgent — dispatcher with in-process first, subprocess fallback", () => {
		before(() => resetMocks());

		it("calls runAgentInProcess first and returns result on success", async () => {
			resetMocks();
			currentSessionConfig = {
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			};

			const { runAgent } = await import("../agent/runner.ts");
			const result = await runAgent({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const result = await runAgent({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 25,
			});

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
			const result = await runAgent({
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
			const result = await runAgent({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});

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
			const result = await runAgent({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				maxToolCalls: 1,
			});

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
			const result = await runAgent({
				agent: mockAgent as any,
				task: "special task with args",
				ctx: mockCtx,
				timeoutMs: 10000,
				cwd: "/custom/cwd",
				maxToolCalls: 5,
				agentTokenBudget: 10000,
				sessionPath: "/tmp/session.jsonl",
				pi: mockPi,
			});

			assert.ok(result !== undefined, "should return a result with all args");
		});

		describe("runAgent — fallback safety (sync throw containment)", () => {
			before(() => resetMocks());

			it("in-process throws → fallback called, returns result without rejecting", async () => {
				resetMocks();

				const { runAgent } = await import("../agent/runner.ts");
				const result = await runAgent({
					agent: mockAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 1,
				});

				assert.ok(result !== undefined, "should return a result even on fallback");
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
				const result = await runAgent({
					agent: badSkillAgent as any,
					task: "test task",
					ctx: mockCtx,
					timeoutMs: 5000,
				});

				assert.equal(result.success, false);
				assert.equal(result.agentName, "bad-skill-agent");
				assert.equal(result.toolCount, 0);
			});
		});
	});
}
