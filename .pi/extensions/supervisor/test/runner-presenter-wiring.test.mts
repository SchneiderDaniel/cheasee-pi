/**
 * runner-presenter-wiring.test.mts — RunPresenter wiring across the runner
 * (issue #2106). Phases 3, 4 and 6 of the test plan.
 *
 * Phase 3: spawned-run + the pre-spawn guards depend on the port only — every
 *          test injects a recording fake presenter, no ctx.ui stub. The shared
 *          event-loop port tests live in agent-event-loop.test.mts.
 * Phase 4: the dependency edges — ui.ts is the sole ctx.ui owner with exactly
 *          one consumer (the composition root).
 * Phase 6: one operator journey: start announcement → widget renders →
 *          widget/working-message/status teardown, in that order.
 *
 * The spawn seam is injected (a fake ChildHandle), so the subprocess cases run
 * without module mocks — that fake is the second adapter of the spawn port.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { readGraph, importersOf } from "../../lib/test/source-graph.ts";
import {
	exhaustedBeforeSpawn,
	prepareSubprocessRun,
	runSpawnedProcess,
} from "../agent/runner/spawned-run.ts";
import { createRunPresenter } from "../agent/runner/ui.ts";
import type { RunPresenter } from "../agent/runner/presenter.ts";
import type { ChildHandle } from "../agent/runner/spawn.ts";
import { createAgentRunState } from "../agent/state-helpers.ts";
import type { AgentRunState, ParsedAgent } from "../config/types.ts";
import { getDebugLogger } from "../lib/debug.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = join(__dirname, "../agent/runner");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readSource = (file: string): string => readFileSync(join(RUNNER_DIR, file), "utf-8");

/** Comments are not dependencies — only real code counts for the edge checks. */
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ─── Recording fake presenter (second adapter) ────────────────────

interface PresenterCall {
	method: string;
	args: unknown[];
}

interface FakePresenter {
	presenter: RunPresenter;
	calls: PresenterCall[];
	count(method: string): number;
	argsOf(method: string): unknown[][];
	indexOf(method: string): number;
}

function createFakePresenter(): FakePresenter {
	const calls: PresenterCall[] = [];
	const record =
		(method: string) =>
		(...args: unknown[]): void => {
			calls.push({ method, args });
		};
	const presenter: RunPresenter = {
		scheduleFlush: record("scheduleFlush"),
		setWorkingMessage: record("setWorkingMessage"),
		announceStart: record("announceStart"),
		clear: record("clear"),
		dispose: record("dispose"),
	};
	return {
		presenter,
		calls,
		count: (method: string) => calls.filter((c) => c.method === method).length,
		argsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
		indexOf: (method: string) => calls.findIndex((c) => c.method === method),
	};
}

// ─── Fake child handle (spawn port adapter) ───────────────────────

interface FakeChild {
	stdout: EventEmitter;
	stderr: EventEmitter;
	closeHandlers: Function[];
	errorHandlers: Function[];
}

interface FakeSpawn {
	spawnChild(opts: unknown): ChildHandle;
	calls: unknown[][];
	/** Null until the use case actually asks for a child. */
	readonly child: FakeChild | null;
	emitStdout(line: string): void;
	emitClose(code: number | null, signal: string | null): void;
	emitError(err: Error): void;
}

function createFakeSpawn(): FakeSpawn {
	const calls: unknown[][] = [];
	let child: FakeChild | null = null;

	const spawnChild = (opts: unknown): ChildHandle => {
		calls.push([opts]);
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const closeHandlers: Function[] = [];
		const errorHandlers: Function[] = [];
		child = { stdout, stderr, closeHandlers, errorHandlers };
		return {
			child: { stdout, stderr, pid: 4242, kill: () => {} } as any,
			childExited: false,
			kill: () => {},
			killGroup: () => null,
			onClose: (cb) => closeHandlers.push(cb),
			onError: (cb) => errorHandlers.push(cb),
		};
	};

	return {
		spawnChild,
		calls,
		get child() {
			return child;
		},
		emitStdout(line: string) {
			child!.stdout.emit("data", Buffer.from(line + "\n"));
		},
		emitClose(code: number | null, signal: string | null) {
			for (const handler of [...child!.closeHandlers]) handler(code, signal);
		},
		emitError(err: Error) {
			for (const handler of [...child!.errorHandlers]) handler(err);
		},
	};
}

// ─── Shared fixtures ──────────────────────────────────────────────

const createState = (): AgentRunState => createAgentRunState(Date.now());

const mockAgent = {
	config: {
		name: "test-agent",
		tools: "read,bash",
		model: "test/model",
		extensions: "",
		skills: "",
		thinking: "",
	},
	systemPrompt: "You are a test agent.",
} as unknown as ParsedAgent;

function spawnOptions(
	over: Partial<Parameters<typeof runSpawnedProcess>[0]> = {},
): Parameters<typeof runSpawnedProcess>[0] {
	return {
		args: ["-p", "task"],
		effectiveCwd: "/tmp",
		sandboxEnv: {},
		presenter: createFakePresenter().presenter,
		agentName: "test-agent",
		state: createState(),
		spawnChild: () => {
			throw new Error("spawn not expected");
		},
		timeoutMs: null,
		remainingMs: null,
		killGraceSec: undefined,
		startedAt: Date.now(),
		log: getDebugLogger(),
		...over,
	};
}

// ─── Phase 3: spawned-run + guards depend on the port only ────────
// (the handleNormalizedEvent port tests live in agent-event-loop.test.mts)

describe("Phase 3b: runSpawnedProcess tears down through the port", () => {
	it("success path → dispose once, clear once, dispose before clear", async () => {
		const fake = createFakePresenter();
		const spawn = createFakeSpawn();
		const promise = runSpawnedProcess(
			spawnOptions({ presenter: fake.presenter, spawnChild: spawn.spawnChild }),
		);

		spawn.emitStdout(
			JSON.stringify({ type: "message_update", delta: { type: "text_delta", text_delta: "done" } }),
		);
		spawn.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
		spawn.emitClose(0, null);

		const result = await promise;
		assert.equal(result.success, true, "clean exit is a success");
		assert.equal(fake.count("dispose"), 1, "presenter disposed exactly once");
		assert.equal(fake.count("clear"), 1, "presenter cleared exactly once");
		assert.ok(fake.indexOf("dispose") < fake.indexOf("clear"), "dispose precedes the teardown");
	});

	it("double terminal signal (close then late error) clears exactly once", async () => {
		const fake = createFakePresenter();
		const spawn = createFakeSpawn();
		const promise = runSpawnedProcess(
			spawnOptions({ presenter: fake.presenter, spawnChild: spawn.spawnChild }),
		);

		spawn.emitClose(0, null);
		spawn.emitError(new Error("late ENOENT"));

		const result = await promise;
		assert.equal(result.success, true);
		assert.equal(fake.count("clear"), 1, "the resolved guard holds against a late error");
		assert.equal(fake.count("dispose"), 1);
	});

	it("spawn error → dispose + clear once, failure result", async () => {
		const fake = createFakePresenter();
		const spawn = createFakeSpawn();
		const promise = runSpawnedProcess(
			spawnOptions({ presenter: fake.presenter, spawnChild: spawn.spawnChild }),
		);

		spawn.emitError(new Error("ENOENT"));

		const result = await promise;
		assert.equal(result.success, false);
		assert.match(result.output, /Failed to start pi:/);
		assert.equal(fake.count("dispose"), 1);
		assert.equal(fake.count("clear"), 1);
	});

	it("spawn rejection → clear once, no child, contract intact", async () => {
		const fake = createFakePresenter();
		const rejecting = (): ChildHandle => {
			throw new TypeError("argv must not contain null bytes");
		};
		const spawn = createFakeSpawn();

		const result = await runSpawnedProcess(
			spawnOptions({ presenter: fake.presenter, spawnChild: rejecting, args: ["bad\0arg"] }),
		);

		assert.equal(result.success, false, "the rejection must not escape the result contract");
		assert.equal(spawn.calls.length, 0, "no child handle was ever created");
		assert.match(result.output, /Failed to start pi:/);
		assert.equal(fake.count("clear"), 1, "a failed spawn still tears the presentation down");
		// The presenter (and its heartbeat) exists before the spawn attempt, so a
		// rejection must stop the timers too — otherwise the cleared widget is
		// re-rendered every 2s for a run that never started.
		assert.equal(fake.count("dispose"), 1, "the failed spawn stops the presentation timers");
		assert.ok(fake.indexOf("dispose") < fake.indexOf("clear"), "timers stopped before the clear");
	});

	it("timed-out close waits for the escalation ladder before teardown", async () => {
		const fake = createFakePresenter();
		const spawn = createFakeSpawn();
		const promise = runSpawnedProcess(
			spawnOptions({
				presenter: fake.presenter,
				spawnChild: spawn.spawnChild,
				remainingMs: 1,
				killGraceSec: 0.02,
			}),
		);

		await wait(8); // deadline fired (SIGTERM), SIGKILL still pending
		spawn.emitClose(null, "SIGTERM");
		assert.equal(fake.count("clear"), 0, "teardown deferred until the escalation settles");

		const result = await promise;
		assert.equal(fake.count("dispose"), 1);
		assert.equal(fake.count("clear"), 1);
		assert.equal(result.timedOut, true, "classified as a timeout");
	});
});

describe("Phase 3c: pre-spawn guards tear down through the port", () => {
	it("exhaustedBeforeSpawn → clear once, timedOut, no spawn", () => {
		const fake = createFakePresenter();
		const spawn = createFakeSpawn();

		const result = exhaustedBeforeSpawn({
			presenter: fake.presenter,
			state: createState(),
			agentName: "test-agent",
			startedAt: Date.now(),
			timeoutMs: 5000,
		});

		assert.equal(fake.count("clear"), 1);
		assert.equal(fake.count("dispose"), 1, "the armed heartbeat is stopped, not leaked");
		assert.equal(result.timedOut, true);
		assert.equal(spawn.calls.length, 0, "nothing is spawned");
	});

	it("arg-build throw → clear once, errorMessage preserved", () => {
		const fake = createFakePresenter();
		// extensions as a number makes resolveTools throw on `.trim()`.
		const broken = {
			config: { name: "test-agent", tools: "read", extensions: 5, skills: "", model: "" },
			systemPrompt: "You are a test agent.",
		} as unknown as ParsedAgent;

		const prepared = prepareSubprocessRun({
			agent: broken,
			task: "task",
			model: "",
			presenter: fake.presenter,
			effectiveCwd: "/tmp",
			timeoutMs: 5000,
			startedAt: Date.now(),
		});

		assert.equal(prepared.ok, false);
		if (prepared.ok) return;
		assert.equal(prepared.result.success, false);
		assert.equal(fake.count("clear"), 1);
		assert.ok(
			typeof prepared.result.errorOutput === "string" && prepared.result.errorOutput.length > 0,
			"errorMessage preserved",
		);
	});

	it("missing effectiveCwd → clear once, summaryLine names the worktree", () => {
		const fake = createFakePresenter();

		const prepared = prepareSubprocessRun({
			agent: mockAgent,
			task: "task",
			model: "",
			presenter: fake.presenter,
			effectiveCwd: "/nonexistent-worktree-2106",
			timeoutMs: 5000,
			startedAt: Date.now(),
		});

		assert.equal(prepared.ok, false);
		if (prepared.ok) return;
		assert.equal(fake.count("clear"), 1);
		assert.ok(
			prepared.result.summaryLine?.startsWith("Worktree missing:"),
			`summaryLine was ${prepared.result.summaryLine}`,
		);
	});

	it("a guard failure disposes the presentation — the cleared widget is never resurrected", async (t) => {
		// The composition root builds the presenter BEFORE the guards run, so the
		// 2s heartbeat is already armed when a guard bails out. clear() alone would
		// leave that interval running and re-render a widget for a run that never
		// started — guard paths must dispose the presentation, then clear it.
		const renders: unknown[][] = [];
		const ctx: any = {
			cwd: "/tmp/work",
			ui: {
				notify: () => {},
				setStatus: () => {},
				setWidget: (...args: unknown[]) => renders.push(args),
				setWorkingMessage: () => {},
			},
		};
		const real = createRunPresenter({
			ctx,
			widgetId: "agent-test-agent",
			agentName: "test-agent",
			model: "",
			state: createState(),
		});
		// A red run must not leave the heartbeat holding the suite open.
		t.after(() => real.dispose());

		const calls: string[] = [];
		const presenter: RunPresenter = {
			scheduleFlush: () => real.scheduleFlush(),
			setWorkingMessage: (message?: string) => real.setWorkingMessage(message),
			announceStart: (agentName: string) => real.announceStart(agentName),
			clear: () => {
				calls.push("clear");
				real.clear();
			},
			dispose: () => {
				calls.push("dispose");
				real.dispose();
			},
		};

		const prepared = prepareSubprocessRun({
			agent: mockAgent,
			task: "task",
			model: "",
			presenter,
			effectiveCwd: "/nonexistent-worktree-2106",
			timeoutMs: 5000,
			startedAt: Date.now(),
		});

		assert.equal(prepared.ok, false);
		assert.deepEqual(calls, ["dispose", "clear"], "the guard stops the timers, then clears");
		assert.equal(renders.length, 1, "the guard cleared the widget once");
		await wait(2200);
		assert.equal(renders.length, 1, "the heartbeat must not re-render a cleared widget");
	});

	it("successful preparation announces the start through the port", () => {
		const fake = createFakePresenter();

		const prepared = prepareSubprocessRun({
			agent: mockAgent,
			task: "task",
			model: "",
			presenter: fake.presenter,
			effectiveCwd: "/tmp",
			timeoutMs: 5000,
			startedAt: Date.now(),
		});

		assert.equal(prepared.ok, true);
		assert.deepEqual(fake.argsOf("announceStart"), [["test-agent"]]);
		assert.equal(fake.count("clear"), 0, "a healthy preparation clears nothing");
	});
});

// ─── Phase 4: composition root + dependency edges ─────────────────

describe("Phase 4: the adapter has exactly one consumer", () => {
	it("only the composition root imports runner/ui.ts", () => {
		assert.deepEqual(importersOf(RUNNER_DIR, "./ui.ts"), ["index.ts"]);
	});

	it("spawned-run.ts depends on the port, never on ui.ts or ctx.ui", () => {
		const graph = readGraph(join(RUNNER_DIR, "spawned-run.ts"));
		assert.ok(
			!graph.specifiers.some((s: string) => /(^|\/)ui\.ts$/.test(s)),
			`spawned-run.ts must not import ui.ts, found ${graph.specifiers.join(", ")}`,
		);
		assert.ok(graph.specifiers.includes("./presenter.ts"), "spawned-run.ts imports the port");
		const source = readFileSync(join(RUNNER_DIR, "spawned-run.ts"), "utf-8");
		assert.ok(!source.includes("ctx.ui"), "spawned-run.ts must not reach into ctx.ui");
	});

	it("event-loop.ts depends on the port, never on ui.ts or ctx.ui", () => {
		const graph = readGraph(join(RUNNER_DIR, "event-loop.ts"));
		assert.ok(
			!graph.specifiers.some((s: string) => /(^|\/)ui\.ts$/.test(s)),
			`event-loop.ts must not import ui.ts, found ${graph.specifiers.join(", ")}`,
		);
		assert.ok(graph.specifiers.includes("./presenter.ts"), "event-loop.ts imports the port");
		const source = readFileSync(join(RUNNER_DIR, "event-loop.ts"), "utf-8");
		assert.ok(!source.includes("ctx.ui"), "event-loop.ts must not reach into ctx.ui");
	});

	it("ui.ts is the only runner module owning ctx.ui (sole adapter invariant)", () => {
		const offenders = readdirSync(RUNNER_DIR)
			.filter((name) => name.endsWith(".ts"))
			.filter((file) => file !== "ui.ts" && stripComments(readSource(file)).includes("ctx.ui"));
		assert.deepEqual(offenders, [], "no runner module outside ui.ts touches ctx.ui");
	});

	it("the composition root knows both the port and the adapter", () => {
		const graph = readGraph(join(RUNNER_DIR, "index.ts"));
		assert.ok(graph.specifiers.includes("./presenter.ts"), "index.ts imports the port");
		assert.ok(graph.specifiers.includes("./ui.ts"), "index.ts imports the adapter");
		assert.ok(
			!graph.starReExports.includes("./ui.ts"),
			"the adapter is not re-exported from the barrel",
		);
	});

	it("the composition root constructs the adapter and injects it into both use cases", () => {
		// The wiring lives in runAgentSubprocess: one presenter instance serves the
		// pre-spawn guards and the spawned run, so a guard failure and a completed
		// run tear down the SAME presentation.
		const source = stripComments(readSource("index.ts"));
		assert.match(source, /createRunPresenter\(\{/, "index.ts builds the adapter");
		assert.match(
			source,
			/prepareSubprocessRun\(\{[\s\S]*?\bpresenter,/,
			"the pre-spawn guards receive the presenter",
		);
		assert.match(
			source,
			/runSpawnedProcess\(\{[\s\S]*?\bpresenter,/,
			"the spawned run receives the presenter",
		);
	});

	it("the barrel no longer exposes the old widget-flusher factory", async () => {
		const mod = await import("../agent/runner.ts");
		assert.equal("createWidgetFlusher" in mod, false);
		assert.equal("createRunPresenter" in mod, false, "the adapter stays out of the barrel surface");
	});
});

// ─── Phase 6: preserved operator-visible feedback (journey) ───────

describe("Phase 6: operator journey (announce → render → teardown)", () => {
	it("start ledger precedes the first render; teardown trio closes the run", async () => {
		const ledger: Array<{ method: string; args: unknown[] }> = [];
		const record =
			(method: string) =>
			(...args: unknown[]): void => {
				ledger.push({ method, args });
			};
		const ctx: any = {
			cwd: "/tmp/work",
			ui: {
				notify: record("notify"),
				setStatus: record("setStatus"),
				setWidget: record("setWidget"),
				setWorkingMessage: record("setWorkingMessage"),
			},
		};
		const spawn = createFakeSpawn();
		const startedAt = Date.now();
		const state = createAgentRunState(startedAt);
		const presenter = createRunPresenter({
			ctx,
			widgetId: "agent-test-agent",
			agentName: "test-agent",
			model: "test/model",
			state,
		});

		// Same wiring order as the composition root (runner/index.ts).
		const prepared = prepareSubprocessRun({
			agent: mockAgent,
			task: "task",
			model: "test/model",
			presenter,
			effectiveCwd: "/tmp",
			timeoutMs: null,
			startedAt,
		});
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;

		const promise = runSpawnedProcess({
			args: prepared.args,
			effectiveCwd: "/tmp",
			sandboxEnv: {},
			presenter,
			agentName: "test-agent",
			state,
			spawnChild: spawn.spawnChild,
			timeoutMs: null,
			remainingMs: null,
			killGraceSec: undefined,
			startedAt,
			log: getDebugLogger(),
		});
		spawn.emitStdout(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} }));
		spawn.emitClose(0, null);
		const result = await promise;

		assert.equal(result.success, true, "the run completes");

		const startIndex = ledger.findIndex((e) => e.method === "notify");
		const statusIndex = ledger.findIndex((e) => e.method === "setStatus");
		const firstRender = ledger.findIndex((e) => e.method === "setWidget");
		assert.deepEqual(ledger[startIndex], {
			method: "notify",
			args: ["Running agent: test-agent...", "info"],
		});
		assert.deepEqual(ledger[statusIndex], {
			method: "setStatus",
			args: ["supervisor", "Running test-agent..."],
		});
		assert.ok(startIndex < statusIndex, "notify then status");
		assert.ok(
			firstRender === -1 || statusIndex < firstRender,
			"the start announcement precedes any widget render",
		);

		const trailing = ledger.slice(-3);
		assert.deepEqual(trailing, [
			{ method: "setWidget", args: ["agent-test-agent", undefined] },
			{ method: "setWorkingMessage", args: [undefined] },
			{ method: "setStatus", args: ["supervisor", undefined] },
		]);
		assert.ok(
			ledger.every((e) => !e.args.includes("")),
			"no empty-string status or working-message values anywhere in the journey",
		);
	});
});
