// ─── Phase 7: rollover and resume ────────────────────────────────
// R5: at the configured token checkpoint the loop verifies first, then either
// completes or starts a FRESH session in the same worktree from the Markdown
// record alone. Counters stay cumulative across sessions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalService } from "../application/goal-service.ts";
import { buildGenerationPrompt } from "../application/goal-service.ts";
import { commandCriterion, createHarness, type Harness } from "./helpers/builders.mts";

async function activate(harness: Harness, maxIterations = 50): Promise<GoalService> {
	harness.deps.loadConfig = () => ({
		ok: true,
		value: {
			settings: {
				model: harness.config.settings.model,
				contextRolloverTokens: harness.config.settings.contextRolloverTokens,
				maxIterations,
			},
			model: harness.config.model,
		},
	});
	const service = new GoalService(harness.deps);
	await service.start("raise coverage of module x");
	const outcome = await service.submitClarification({
		ready: true,
		clarifiedGoal: "raise coverage of module x to 90%",
		criteria: [commandCriterion("c1", ["npm", "test"])],
	});
	if (!outcome.ok) throw new Error(`goal did not start: ${outcome.error}`);
	assert.equal(outcome.value.started, true);
	return service;
}

describe("context rollover", () => {
	it("checkpoints before starting the next generation", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = 200_000;
		harness.log.clear();

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "rollover");
		const startIndex = harness.log.calls.indexOf("runtime.start");
		assert.ok(startIndex > 0);
		const lastWriteBeforeStart = harness.log.calls.lastIndexOf("store.write", startIndex);
		assert.ok(lastWriteBeforeStart >= 0, "a checkpoint write precedes the fresh session start");

		// The last record on disk before the start is the rollover checkpoint.
		const checkpoint = harness.store.writes.at(-1)!;
		assert.ok(checkpoint.nextAction.length > 0, "nextAction is non-empty");
		assert.equal(checkpoint.worktree, "/tmp/worktrees/goal-1");
		assert.equal(checkpoint.resets, 1);
		assert.equal(harness.runtime.starts.length, 2);
	});

	it("starts the fresh generation from the record alone", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = 200_000;
		await service.reportIteration({ summary: "half done", nextAction: "finish the tests" });

		await service.onBoundary();

		const start = harness.runtime.starts.at(-1)!;
		assert.match(start.prompt, /raise coverage of module x to 90%/);
		assert.match(start.prompt, /c1/);
		assert.match(start.prompt, /npm test/);
		assert.match(start.prompt, /finish the tests/);
		assert.equal(start.worktree, "/tmp/worktrees/goal-1");
		assert.equal(start.model, "provider/model-id");
		assert.equal(start.generation, 1);
		// Plain data only — no transcript, no message history, no functions.
		for (const value of Object.values(start)) {
			assert.ok(
				typeof value === "string" || typeof value === "number",
				"generation input is plain data",
			);
		}
	});

	it("keeps counters cumulative across three rollovers", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = 200_000;

		for (let i = 0; i < 3; i++) await service.onBoundary();

		const record = service.current()!;
		assert.equal(record.resets, 3);
		assert.equal(record.iterations, 3);
		assert.equal(record.generation, 3);
		assert.equal(record.worktree, "/tmp/worktrees/goal-1");
		assert.equal(record.branch, "goal/goal-1");
		assert.equal(harness.store.writes.filter((w) => w.id === record.id).length > 0, true);
	});

	it("completes at the threshold instead of rolling over", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.runtime.tokens = 200_000;
		const startsBefore = harness.runtime.starts.length;

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "complete");
		assert.equal(boundary.value.record.resets, 0);
		assert.equal(harness.runtime.starts.length, startsBefore);
	});

	it("pauses when verification cannot run at the threshold", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.runtime.tokens = 200_000;
		harness.checks.throwOn = "c1";
		const startsBefore = harness.runtime.starts.length;

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "pause");
		assert.equal(boundary.value.record.status, "paused");
		assert.equal(harness.runtime.starts.length, startsBefore);
	});

	it("pauses with a saved checkpoint when the fresh session cannot start", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = 200_000;
		harness.runtime.startError = "no credentials";

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.record.status, "paused");
		assert.match(
			boundary.value.record.blocker ?? "",
			/fresh session could not start: no credentials/,
		);
		const lastWrite = harness.store.writes.at(-1)!;
		assert.equal(lastWrite.status, "paused");
		assert.ok(lastWrite.nextAction.length > 0);
	});

	it("persists an observed in-place compaction and rolls over below the threshold", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = 1_000;
		harness.runtime.compactionSeen = true;

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "rollover");
		assert.ok(
			harness.store.writes.some((write) => write.compactionSeen === true),
			"the compaction observation is durable",
		);
		assert.equal(service.current()!.compactionSeen, false, "cleared after the rollover");
	});

	it("does not roll over on an unknown token count", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		harness.runtime.tokens = null;

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (boundary.ok) assert.equal(boundary.value.decision.kind, "continue");
	});
});

describe("resume after a pause", () => {
	it("requires explicit approval", async () => {
		const harness = createHarness();
		const service = await activate(harness, 1);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		await service.onBoundary();
		assert.equal(service.current()!.status, "paused");

		const refused = await service.resume({ approve: false });
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.match(refused.error, /--approve/);
		assert.equal(service.current()!.status, "paused");

		const resumed = await service.resume({ approve: true });
		assert.equal(resumed.ok, true);
		if (resumed.ok) assert.equal(resumed.value.status, "active");
		assert.equal(harness.runtime.starts.length, 2);
	});

	it("reloads the configuration at the next generation start", async () => {
		const harness = createHarness();
		const service = await activate(harness, 1);
		await service.publish();
		harness.checks.results.set("c1", "fail");
		await service.onBoundary();

		harness.deps.loadConfig = () => ({
			ok: true,
			value: {
				settings: {
					model: "other/model",
					contextRolloverTokens: 100_000,
					maxIterations: 9,
				},
				model: { ref: "other/model", id: "model", provider: "other", contextWindow: 400_000 },
			},
		});
		const resumed = await service.resume({ approve: true });
		assert.equal(resumed.ok, true);
		if (resumed.ok) {
			assert.equal(resumed.value.config.model, "other/model");
			assert.equal(resumed.value.config.maxIterations, 9);
		}
	});
});

describe("generation prompt", () => {
	it("carries the clarified goal, the criteria and the next action", () => {
		const prompt = buildGenerationPrompt({
			...{
				id: "20260102-030405-add-a-feature-abcd",
				status: "active" as const,
				request: "do it",
				clarifiedGoal: "raise coverage to 90%",
				criteria: [commandCriterion("c1", ["npm", "test"])],
				verification: [],
				iterations: 2,
				windowIterations: 0,
				resets: 1,
				generation: 1,
				lastCheckpoint: "2026-01-02T03:04:05.000Z",
				nextAction: "fix the last failing test",
				config: { model: "provider/model-id", rolloverTokens: 150_000, maxIterations: 50 },
				worktree: "/tmp/wt",
				branch: "goal/x",
				pr: null,
				blocker: null,
				steering: [],
				compactionSeen: false,
				inFlight: false,
			},
		});
		assert.match(prompt, /raise coverage to 90%/);
		assert.match(prompt, /c1/);
		assert.match(prompt, /fix the last failing test/);
		assert.match(prompt, /goal_report_iteration/);
	});
});
