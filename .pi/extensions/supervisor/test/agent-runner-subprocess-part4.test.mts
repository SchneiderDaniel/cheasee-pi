import { describe, it, mock } from "node:test";

import assert from "node:assert/strict";

import { EventEmitter } from "node:events";

import { existsSync } from "node:fs";

import { join } from "node:path";

import * as childProcessModule from "node:child_process";

interface MockChild {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof mock.fn>;
	pid: number;
	_ref: { exitHandler?: Function; closeHandlers: Function[]; errorHandlers: Function[] };
	on: (event: string, handler: Function) => void;
}

let currentMockChild: MockChild | null = null;

let currentMockOpts: {
	stdoutLines?: string[];
	stderrLines?: string[];
	exitCode?: number | null;
	exitSignal?: string | null;
} = {};

let lastSpawnOpts: Record<string, unknown> | null = null;

function createMockChild(): MockChild {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const kill = mock.fn();
	const ref = {
		exitHandler: undefined as Function | undefined,
		closeHandlers: [] as Function[],
		errorHandlers: [] as Function[],
	};

	const child: MockChild = {
		stdout: stdout as any,
		stderr: stderr as any,
		kill,
		pid: 12345,
		_ref: ref,
		on: (event: string, handler: Function) => {
			if (event === "exit") ref.exitHandler = handler;
			else if (event === "close") ref.closeHandlers.push(handler);
			else if (event === "error") ref.errorHandlers.push(handler);
		},
	};

	currentMockChild = child;
	return child;
}

function emitMockEvents(): void {
	const child = currentMockChild;
	if (!child) throw new Error("No mock child available — was runAgentSubprocess called?");

	const opts = currentMockOpts;

	// Emit stdout data lines
	if (opts.stdoutLines) {
		for (const line of opts.stdoutLines) {
			child.stdout.emit("data", Buffer.from(line + "\n"));
		}
	}

	// Emit stderr data lines
	if (opts.stderrLines) {
		for (const line of opts.stderrLines) {
			child.stderr.emit("data", Buffer.from(line + "\n"));
		}
	}

	// Emit exit first (process table cleanup)
	if (child._ref.exitHandler) {
		child._ref.exitHandler(opts.exitCode ?? 0, opts.exitSignal ?? null);
	}

	// Emit close after stdio drains
	for (const h of child._ref.closeHandlers) {
		h(opts.exitCode ?? 0, opts.exitSignal ?? null);
	}
}

const hasMockModule = typeof mock.module === "function";

const mockSpawn = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
	lastSpawnOpts = opts;
	return createMockChild();
};

const namedExports: Record<string, unknown> = {};

for (const key of Object.keys(childProcessModule)) {
	namedExports[key] = (childProcessModule as any)[key];
}

namedExports.spawn = mockSpawn;

if (hasMockModule) {
	mock.module("node:child_process", {
		namedExports,
	});
}

const mockAgent = {
	config: {
		name: "test-agent",
		tools: "read,bash",
		model: "anthropic/claude-sonnet-4-20250514",
		extensions: "",
		skills: "",
		thinking: "",
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resetMock(): void {
	currentMockChild = null;
	lastSpawnOpts = null;
	currentMockOpts = {};
	mockCtx.ui.setWidget = mock.fn();
	mockCtx.ui.setWorkingMessage = mock.fn();
	(mockCtx.ui.setWidget as any).mock.resetCalls?.();
	(mockCtx.ui.setWorkingMessage as any).mock.resetCalls?.();
}

if (hasMockModule) {
	describe("buildSubprocessArgs — return struct", () => {
		it("returns { args, tools, skillPaths } with correct types", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(Array.isArray(result.args));
			assert.equal(typeof result.tools, "string");
			assert.ok(Array.isArray(result.skillPaths));
			assert.equal(result.toolSpillDir, undefined);
		});

		it("args array includes expected CLI flags", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.args.includes("--mode"), "should have --mode");
			assert.ok(result.args.includes("json"), "should have json");
			assert.ok(result.args.includes("--system-prompt"), "should have --system-prompt");
			assert.ok(result.args.includes("--tools"), "should have --tools");
			assert.ok(result.args.includes("--no-extensions"), "should have --no-extensions");
			assert.ok(result.args.includes("--no-skills"), "should have --no-skills");
			assert.ok(result.args.includes("--no-context-files"), "should have --no-context-files");
		});

		it("tools string matches resolved tools from agent config", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.tools.includes("read"), "tools should contain read");
			assert.ok(result.tools.includes("bash"), "tools should contain bash");
		});

		it("toolSpillDir is present when task > SAFE_TASK_CHARS (1,200,000)", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const largeTask = "x".repeat(1_200_001);
			const result = buildSubprocessArgs(mockAgent as any, largeTask, "/tmp");
			assert.ok(result.toolSpillDir !== undefined, "toolSpillDir should be present for large task");
			assert.ok(
				typeof result.toolSpillDir === "string" && result.toolSpillDir.length > 0,
				"toolSpillDir should be a non-empty string",
			);
		});

		it("toolSpillDir is undefined when task ≤ SAFE_TASK_CHARS", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "small task", "/tmp");
			assert.equal(result.toolSpillDir, undefined);
		});

		it("args with model includes --model flag", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const result = buildSubprocessArgs(mockAgent as any, "test task", "/tmp");
			assert.ok(result.args.includes("--model"), "should have --model");
			assert.ok(
				result.args.includes("anthropic/claude-sonnet-4-20250514"),
				"should include model name",
			);
		});

		it("args without model omits --model flag", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const noModelAgent = {
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
			const result = buildSubprocessArgs(noModelAgent as any, "test task", "/tmp");
			assert.ok(!result.args.includes("--model"), "should not have --model when empty");
		});

		it("missing skill with cwd lacking settings → no throw, skillPaths [], no --skill flag", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const badSkillAgent = {
				config: {
					name: "bad-skill-agent",
					tools: "read",
					model: "",
					extensions: "",
					skills: "definitely-missing-skill-xyz",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};
			const result = buildSubprocessArgs(badSkillAgent as any, "test task", "/tmp");
			assert.deepEqual(result.skillPaths, []);
			assert.ok(!result.args.includes("--skill"), "no --skill flag for missing skill");
			assert.ok(result.args.includes("--no-skills"), "--no-skills still present");
		});

		it("mixed resolvable + missing skill → only resolvable --skill emitted", async () => {
			const { buildSubprocessArgs } = await import("../agent/runner.ts");
			const mixedAgent = {
				config: {
					name: "mixed-agent",
					tools: "read",
					model: "",
					extensions: "",
					skills: "extension-spec, definitely-missing-skill-xyz",
					thinking: "",
				},
				systemPrompt: "You are a test agent.",
			};
			const result = buildSubprocessArgs(mixedAgent as any, "test task", process.cwd());
			const skillFlags = result.args.filter((a) => a === "--skill");
			const hasPrivatePi = existsSync(
				join(process.cwd(), "private-pi", "skills", "extension-spec", "SKILL.md"),
			);
			if (hasPrivatePi) {
				assert.equal(result.skillPaths.length, 1);
				assert.ok(
					result.skillPaths[0]!.endsWith("extension-spec/SKILL.md"),
					`got ${result.skillPaths[0]}`,
				);
				assert.equal(skillFlags.length, 1, "exactly one --skill flag");
				assert.ok(result.args.includes("--no-skills"), "--no-skills still present");
			} else {
				// Host-side private-pi clone absent → both skills fail open
				assert.deepEqual(result.skillPaths, []);
				assert.equal(skillFlags.length, 0);
			}
		});
	});
	describe("runAgentSubprocess — safe fallback (guarded pre-Promise block)", () => {
		it("missing skill does not throw — subprocess runs with skill skipped (fail-open)", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Completed." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
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

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: badSkillAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents();
			const result = await resultPromise;

			assert.equal(result.success, true);
			assert.equal(result.agentName, "bad-skill-agent");
		});

		it("existsSync(effectiveCwd) guard still returns {success: false} (regression)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const result = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				cwd: "/nonexistent-path-12345",
			});

			assert.equal(result.success, false);
			assert.ok(
				result.summaryLine.includes("Worktree missing"),
				`summaryLine should mention worktree missing: ${result.summaryLine}`,
			);
			assert.equal(result.agentName, "test-agent");
		});

		it("runAgentSubprocess never rejects for any input (bad skill, bad cwd)", async () => {
			const { runAgentSubprocess } = await import("../agent/runner.ts");

			// Bad cwd — guarded before spawn, resolves without rejection
			const badCwdResult = await runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
				cwd: "/nonexistent-path-12345",
			});
			assert.equal(badCwdResult.success, false);
			assert.equal(badCwdResult.agentName, "test-agent");

			// Bad skill — fail-open: agent runs without the missing skill
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Done." },
					}),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
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

			const resultPromise = runAgentSubprocess({
				agent: badSkillAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.success, true);
			assert.equal(result.agentName, "bad-skill-agent");
		});

		it("normal subprocess happy path still resolves with success: true (regression)", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Completed." },
					}),
					JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
			};

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents();
			const result = await resultPromise;
			assert.equal(result.success, true);
		});

		it("fail-open missing skill still produces AgentRunResult with all expected fields", async () => {
			resetMock();
			currentMockOpts = {
				stdoutLines: [
					JSON.stringify({
						type: "message_update",
						delta: { type: "text_delta", text_delta: "Finished." },
					}),
					JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
				],
				exitCode: 0,
				exitSignal: null,
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

			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: badSkillAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents();
			const result = await resultPromise;

			// Verify all AgentRunResult fields are present
			assert.equal(typeof result.success, "boolean");
			assert.equal(typeof result.agentName, "string");
			assert.equal(typeof result.toolCount, "number");
			assert.equal(typeof result.tokenCount, "number");
			assert.equal(typeof result.durationMs, "number");
			assert.equal(typeof result.textOutput, "string");
			assert.equal(typeof result.textOnly, "string");
			assert.equal(typeof result.summaryLine, "string");
			assert.equal(typeof result.errorOutput, "string");
			assert.equal(typeof result.output, "string");
			assert.ok("budgetExceeded" in result);
		});
	});
	describe("runAgentSubprocess — spawn options (detached group leader)", () => {
		it("spawn opts include detached:true and NO timeout (watchdog owns kills)", async () => {
			resetMock();
			const { runAgentSubprocess } = await import("../agent/runner.ts");
			const resultPromise = runAgentSubprocess({
				agent: mockAgent as any,
				task: "test task",
				ctx: mockCtx,
				timeoutMs: 5000,
			});
			emitMockEvents();
			await resultPromise;

			assert.ok(lastSpawnOpts, "spawn options captured");
			assert.equal(lastSpawnOpts!.detached, true, "process-group leader (kill(-pid) target)");
			assert.equal("timeout" in lastSpawnOpts!, false, "spawn's own timeout removed");
		});
	});
}
