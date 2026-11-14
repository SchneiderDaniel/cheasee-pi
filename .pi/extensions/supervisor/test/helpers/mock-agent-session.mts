/**
 * mock-agent-session.ts — Shared in-process `AgentSession` mock for supervisor tests.
 *
 * The `agent-runner-in-process*.test.mts` suites used to carry byte-identical
 * copies of the session factory, the manager stubs and the two `mock.module`
 * export builders (issue #2105). Those live here once.
 *
 * Module-mock registration deliberately stays in each test file: module mocks
 * are per-process and must be installed before the runner module is imported.
 * The suites pass `() => currentSessionConfig` so every factory reads the live
 * config at call time.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MockSessionConfig {
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
	/**
	 * Delay (ms) burned SYNCHRONOUSLY inside getBuiltinModel — models model
	 * resolution that cannot be pre-empted by a timer (audit finding #1).
	 */
	slowSyncSetupMs?: number;
}

/** The slice of the SDK session surface `runAgentInProcess` consumes. */
export interface MockAgentSession {
	subscribe(fn: (event: Record<string, unknown>) => void): () => void;
	prompt(task: string): Promise<void>;
	abort(): void;
	dispose(): void;
	agent: { state: { messages: unknown[] } };
	isStreaming: boolean;
}

/** Build an SDK-shaped session whose behaviour and flags live on `config`. */
export function createMockSession(config: MockSessionConfig): MockAgentSession {
	const subscribers: Array<(event: Record<string, unknown>) => void> = [];
	let pendingReject: ((err: Error) => void) | null = null;

	const session: MockAgentSession = {
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

export interface MockSessionManagerStub {
	create(cwd: string): { getCwd(): string; getSessionDir(): string };
	inMemory(): { getCwd(): undefined; getSessionDir(): undefined };
}

export function createMockSessionManager(): MockSessionManagerStub {
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

export interface MockSettingsManagerStub {
	inMemory(): Record<string, unknown>;
}

export function createMockSettingsManager(): MockSettingsManagerStub {
	return {
		inMemory: () => ({}),
	};
}

export interface ProviderMockExports {
	getBuiltinModel(provider: string, id: string): { id: string; provider: string; api: string };
}

/**
 * `namedExports` for `@earendil-works/pi-ai/providers/all`.
 *
 * `agent-session-runner.ts` imports `getBuiltinModel` from that subpath, so the
 * mock must target it (the bare package export is not what the runner consumes).
 * `config.slowSyncSetupMs` busy-waits before resolving, modelling SYNCHRONOUS
 * setup that a timer cannot pre-empt.
 */
export function createProviderMockExports(getConfig: () => MockSessionConfig): ProviderMockExports {
	return {
		getBuiltinModel: (provider: string, id: string) => {
			const slowSyncSetupMs = getConfig().slowSyncSetupMs ?? 0;
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
	};
}

export interface CodingAgentMockExports {
	createAgentSession(opts?: unknown): Promise<MockAgentSession>;
	SessionManager: MockSessionManagerStub;
	SettingsManager: MockSettingsManagerStub;
	createBashToolDefinition(cwd: string): Record<string, unknown>;
	createReadToolDefinition(cwd: string): Record<string, unknown>;
	createWriteToolDefinition(cwd: string): Record<string, unknown>;
	createEditToolDefinition(cwd: string): Record<string, unknown>;
	createGrepToolDefinition(cwd: string): Record<string, unknown>;
	createFindToolDefinition(cwd: string): Record<string, unknown>;
	createLsToolDefinition(cwd: string): Record<string, unknown>;
	initTheme(): void;
	getMarkdownTheme(): Record<string, unknown>;
}

/**
 * `namedExports` for `@earendil-works/pi-coding-agent`. The config is read at
 * call time, so a suite can mutate `currentSessionConfig` between calls.
 */
export function createCodingAgentMockExports(
	getConfig: () => MockSessionConfig,
): CodingAgentMockExports {
	return {
		createAgentSession: async (_opts?: unknown) => {
			const config = getConfig();
			// A setup that never settles models a provider/SDK hang: the
			// dispatch must still return at the deadline with no prompt started.
			if (config.setupNeverSettles) {
				await new Promise<never>(() => {});
			}
			// Setup delay models SDK session creation time — must count
			// against the wall-clock deadline armed at runner entry.
			if (config.setupDelayMs) {
				await sleep(config.setupDelayMs);
			}
			return createMockSession(config);
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
	};
}
