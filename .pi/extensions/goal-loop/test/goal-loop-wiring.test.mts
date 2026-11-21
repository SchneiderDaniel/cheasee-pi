// ─── Phase 12: Pi wiring ─────────────────────────────────────────
// The wiring is a humble translator: it registers the command, the steering
// `input` handler, the `agent_before_settle` continuation and the two agent
// tools, and it never replaces the session.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GOAL_COMMAND, parseGoalArgs, registerGoalLoop } from "../index.ts";
import type { GoalService } from "../application/goal-service.ts";
import type { BoundaryDecision } from "../domain/boundary-policy.ts";
import { buildRecord, commandCriterion, createHarness } from "./helpers/builders.mts";
import { createRecordingPi, createUiCtx } from "./helpers/recording-pi.mts";
import { PiGoalAgentRuntime } from "../adapters/pi-goal-runtime.ts";

interface StubState {
	record: ReturnType<typeof buildRecord> | null;
	decision: BoundaryDecision;
	boundaries: number;
	steers: string[];
	clarifyMessages: string[];
	startError?: string;
}

function stubService(state: StubState): GoalService {
	const service = {
		current: () => state.record,
		hasActiveGoal: () =>
			state.record !== null &&
			state.record.status !== "complete" &&
			state.record.status !== "cancelled",
		onBoundary: async () => {
			state.boundaries += 1;
			if (!state.record) throw new Error("no active goal");
			// A duplicate settle for the SAME iteration leaves the counters alone,
			// which is exactly the case the wiring's continuation guard must catch.
			return {
				ok: true as const,
				value: {
					record: state.record,
					decision: state.decision,
					message: state.decision.kind,
				},
			};
		},
		steer: async (text: string) => {
			state.steers.push(text);
			state.record = { ...state.record!, steering: [...state.record!.steering, text] };
			return { ok: true as const, value: state.record! };
		},
		recordClarificationMessage: async (text: string) => {
			state.clarifyMessages.push(text);
			return { ok: true as const, value: state.record! };
		},
		start: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		submitClarification: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		reportIteration: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		publish: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		stop: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		resume: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		revise: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		cleanup: async () => ({ ok: false as const, error: "stub", source: "stub" }),
		status: () => (state.record ? `status: ${state.record.status}` : "no active goal"),
	};
	return service as unknown as GoalService;
}

function wire(state: StubState) {
	const recording = createRecordingPi();
	const runtime = { markCompaction: () => {} };
	const service = stubService(state);
	registerGoalLoop(recording.pi, {
		resolveBackend: async () => ({ ok: true, value: { service, runtime } }),
	});
	return { recording, service };
}

describe("registration", () => {
	it("registers /goal, the input handler, the settle handler and both tools", () => {
		const { recording } = wire({
			record: null,
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		});
		assert.equal(recording.commands.has(GOAL_COMMAND), true);
		assert.ok((recording.handlers.get("input") ?? []).length >= 1);
		assert.ok((recording.handlers.get("agent_before_settle") ?? []).length >= 1);
		assert.ok((recording.handlers.get("session_compact") ?? []).length >= 1);
		assert.equal(recording.tools.has("goal_submit_clarification"), true);
		assert.equal(recording.tools.has("goal_report_iteration"), true);
		assert.match(recording.commands.get(GOAL_COMMAND)!.description ?? "", /status.*stop.*resume/);
	});
});

describe("agent_before_settle", () => {
	it("does not run a work boundary while the goal is clarifying", async () => {
		const state: StubState = {
			record: buildRecord({ status: "clarifying", iterations: 0, generation: 0 }),
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		const ui = createUiCtx();

		const result = await recording.emit("agent_before_settle", {}, ui.ctx);
		assert.equal(result, undefined);
		assert.equal(state.boundaries, 0);
	});

	it("returns no continuation when no goal exists", async () => {
		const { recording } = wire({
			record: null,
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		});
		const ui = createUiCtx();
		const result = await recording.emit("agent_before_settle", {}, ui.ctx);
		assert.equal(result, undefined);
	});

	it("continues once for one completed iteration", async () => {
		const state: StubState = {
			record: buildRecord({ status: "active", iterations: 0, generation: 0 }),
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		const ui = createUiCtx();

		const first = await recording.emit("agent_before_settle", {}, ui.ctx);
		assert.deepEqual(first, { continue: true });
		assert.equal(state.boundaries, 1);

		// Re-entrant settle for the SAME iteration (iterations did not advance)
		// produces no second continuation.
		const again = await recording.emit("agent_before_settle", {}, ui.ctx);
		assert.equal(again, undefined);
		assert.equal(state.boundaries, 1);
	});

	it("returns no continuation for pause, cap, rollover or complete", async () => {
		for (const decision of [
			{ kind: "pause", reason: "blocked", detail: "no network" },
			{ kind: "pause-cap" },
			{ kind: "rollover" },
			{ kind: "complete" },
		] as BoundaryDecision[]) {
			const state: StubState = {
				record: buildRecord({ status: "active", iterations: 0, generation: 0 }),
				decision,
				boundaries: 0,
				steers: [],
				clarifyMessages: [],
			};
			const { recording } = wire(state);
			const ui = createUiCtx();
			const result = await recording.emit("agent_before_settle", {}, ui.ctx);
			assert.equal(result, undefined, decision.kind);
			assert.equal(state.boundaries, 1, `${decision.kind} still wrote state`);
		}
	});

	it("never replaces the session from the settle handler", async () => {
		const state: StubState = {
			record: buildRecord({ status: "active", iterations: 0, generation: 0 }),
			decision: { kind: "rollover" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		const ui = createUiCtx();

		// `newSession` throws — the boundary must still resolve.
		const result = await recording.emit("agent_before_settle", {}, ui.ctx);
		assert.equal(result, undefined);
		assert.equal(ui.newSessionCalls, 0);
	});
});

describe("input", () => {
	it("steers an active goal without touching the criteria", async () => {
		const state: StubState = {
			record: buildRecord({ status: "active", criteria: [commandCriterion()] }),
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		const ui = createUiCtx();
		const criteriaBefore = JSON.stringify(state.record!.criteria);

		const result = await recording.emit("input", { text: "use the existing helper" }, ui.ctx);
		assert.equal(result, undefined, "the message still reaches the agent");
		assert.deepEqual(state.steers, ["use the existing helper"]);
		assert.equal(JSON.stringify(state.record!.criteria), criteriaBefore);
	});

	it("routes messages to the clarification path while clarifying", async () => {
		const state: StubState = {
			record: buildRecord({ status: "clarifying" }),
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		const ui = createUiCtx();

		await recording.emit("input", { text: "it is the billing module" }, ui.ctx);
		assert.deepEqual(state.clarifyMessages, ["it is the billing module"]);
		assert.deepEqual(state.steers, []);
	});

	it("ignores input when no goal exists", async () => {
		const { recording } = wire({
			record: null,
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		});
		const ui = createUiCtx();
		const result = await recording.emit("input", { text: "hello" }, ui.ctx);
		assert.equal(result, undefined);
	});

	it("surfaces a steering rejection instead of swallowing it", async () => {
		const state: StubState = {
			record: buildRecord({ status: "active" }),
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		};
		const { recording } = wire(state);
		// Replace the service with one whose steer fails.
		const failing = {
			...stubService(state),
			steer: async () => ({ ok: false, error: "session gone", source: "x" }),
		};
		const recording2 = createRecordingPi();
		registerGoalLoop(recording2.pi, {
			resolveBackend: async () => ({
				ok: true,
				value: { service: failing as unknown as GoalService },
			}),
		});
		const ui = createUiCtx();

		const result = await recording2.emit("input", { text: "steer" }, ui.ctx);
		assert.deepEqual(result, { action: "handled" });
		assert.ok(ui.notifications.some((n) => n.type === "error" && /session gone/.test(n.message)));
		void recording;
	});
});

describe("/goal commands", () => {
	it("prints an explicit message when there is no active goal", async () => {
		const { recording } = wire({
			record: null,
			decision: { kind: "continue" },
			boundaries: 0,
			steers: [],
			clarifyMessages: [],
		});
		const ui = createUiCtx();
		await recording.runCommand(GOAL_COMMAND, "status", ui.ctx);
		assert.ok(ui.notifications.some((n) => n.message.includes("no active goal")));
	});

	it("surfaces a service rejection as a UI error", async () => {
		const recording = createRecordingPi();
		const service = {
			current: () => null,
			hasActiveGoal: () => false,
			status: () => "no active goal",
			start: async () => ({ ok: false, error: "goalLoop.model is required", source: "goalLoop" }),
		} as unknown as GoalService;
		registerGoalLoop(recording.pi, {
			resolveBackend: async () => ({ ok: true, value: { service } }),
		});
		const ui = createUiCtx();

		await recording.runCommand(GOAL_COMMAND, "ship the thing", ui.ctx);
		const error = ui.notifications.find((n) => n.type === "error");
		assert.ok(error);
		assert.match(error!.message, /goalLoop\.model is required/);
	});

	it("surfaces a backend resolution failure", async () => {
		const recording = createRecordingPi();
		registerGoalLoop(recording.pi, {
			resolveBackend: async () => ({ ok: false, error: "no goalLoop key", source: "goalLoop" }),
		});
		const ui = createUiCtx();
		await recording.runCommand(GOAL_COMMAND, "status", ui.ctx);
		assert.ok(
			ui.notifications.some((n) => n.type === "error" && /no goalLoop key/.test(n.message)),
		);
	});

	it("parses subcommands and flags", () => {
		assert.deepEqual(parseGoalArgs("").subcommand, "status");
		assert.deepEqual(parseGoalArgs("status").subcommand, "status");
		assert.deepEqual(parseGoalArgs("stop").subcommand, "stop");
		assert.equal(parseGoalArgs("resume --approve").flags.has("--approve"), true);
		assert.equal(parseGoalArgs("cleanup --confirm").flags.has("--confirm"), true);
		assert.equal(parseGoalArgs("revise").subcommand, "revise");
		const started = parseGoalArgs("add a verified goal loop");
		assert.equal(started.subcommand, "start");
		assert.equal(started.rest, "add a verified goal loop");
	});
});

describe("runtime start preconditions", () => {
	it("refuses to create a session without a worktree or a model", async () => {
		const created: unknown[] = [];
		const runtime = new PiGoalAgentRuntime({
			createSession: async (input) => {
				created.push(input);
				return {
					steer: async () => {},
					abort: async () => {},
					dispose: async () => {},
					contextTokens: () => null,
				};
			},
		});

		const noWorktree = await runtime.start({
			goalId: "g",
			worktree: "",
			model: "p/m",
			prompt: "p",
			generation: 0,
		});
		assert.equal(noWorktree.ok, false);
		if (!noWorktree.ok) assert.match(noWorktree.error, /requires the goal worktree/);

		const noModel = await runtime.start({
			goalId: "g",
			worktree: "/tmp/wt",
			model: "",
			prompt: "p",
			generation: 0,
		});
		assert.equal(noModel.ok, false);
		if (!noModel.ok) assert.match(noModel.error, /requires the configured goal model/);
		assert.equal(created.length, 0);
	});

	it("passes cwd and model through to the session factory", async () => {
		const created: Array<{ cwd: string; model: string; prompt: string }> = [];
		const runtime = new PiGoalAgentRuntime({
			createSession: async (input) => {
				created.push(input);
				return {
					steer: async () => {},
					abort: async () => {},
					dispose: async () => {},
					contextTokens: () => 1234,
				};
			},
		});

		const started = await runtime.start({
			goalId: "g",
			worktree: "/tmp/worktrees/goal-1",
			model: "provider/model-id",
			prompt: "continue",
			generation: 0,
		});
		assert.equal(started.ok, true);
		assert.deepEqual(created[0], {
			cwd: "/tmp/worktrees/goal-1",
			model: "provider/model-id",
			prompt: "continue",
		});
		assert.equal(runtime.contextTokens(), 1234);
	});

	it("tracks an observed compaction exactly once", () => {
		const runtime = new PiGoalAgentRuntime({
			createSession: async () => ({
				steer: async () => {},
				abort: async () => {},
				dispose: async () => {},
				contextTokens: () => null,
			}),
		});
		runtime.markCompaction();
		assert.equal(runtime.takeCompactionSeen(), true);
		assert.equal(runtime.takeCompactionSeen(), false);
	});

	it("works against a real service so the wire has no hidden adapter", async () => {
		const harness = createHarness();
		const recording = createRecordingPi();
		const { GoalService } = await import("../application/goal-service.ts");
		const service = new GoalService(harness.deps);
		registerGoalLoop(recording.pi, {
			resolveBackend: async () => ({ ok: true, value: { service } }),
		});
		const ui = createUiCtx();
		await recording.runCommand(GOAL_COMMAND, "status", ui.ctx);
		assert.ok(ui.notifications.some((n) => n.message.includes("no active goal")));
	});
});
