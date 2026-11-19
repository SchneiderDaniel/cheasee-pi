// ─── Phase 5: clarification gate + start ─────────────────────────
// R1: nothing runs until the goal is measurable, reachable and verifiable —
// and once it is, work starts without another confirmation step.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalService } from "../application/goal-service.ts";
import {
	buildRecord,
	commandCriterion,
	createHarness,
	inspectCriterion,
} from "./helpers/builders.mts";

function serviceFor(harness: ReturnType<typeof createHarness>): GoalService {
	return new GoalService(harness.deps);
}

describe("/goal <description> — record only", () => {
	it("writes exactly one clarifying record and creates no worktree or session", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);

		const started = await service.start("make it better");
		assert.equal(started.ok, true);
		if (!started.ok) return;

		assert.equal(harness.store.writes.length, 1);
		assert.equal(harness.store.writes[0]!.status, "clarifying");
		assert.equal(harness.store.writes[0]!.request, "make it better");
		assert.equal(harness.workspace.prepareCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
	});

	it("refuses an empty description", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		const started = await service.start("   ");
		assert.equal(started.ok, false);
		assert.equal(harness.store.writes.length, 0);
	});

	it("refuses to start when goalLoop configuration is unusable", async () => {
		const harness = createHarness({
			loadConfig: () => ({ ok: false, error: "goalLoop.model is required", source: "goalLoop" }),
		});
		const service = serviceFor(harness);
		const started = await service.start("make it better");
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /goalLoop\.model/);
		assert.equal(harness.store.writes.length, 0);
	});

	it("aborts when the initial record cannot be written", async () => {
		const harness = createHarness();
		harness.store.failAfterWrites = 0;
		const service = serviceFor(harness);

		const started = await service.start("make it better");
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /goal state write failed/);
		assert.equal(harness.workspace.prepareCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
		assert.equal(harness.store.lockAcquired, false);
	});
});

describe("clarification round", () => {
	it("keeps clarifying and surfaces the questions when not ready", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: false,
			questions: ["which module?", "how is it tested?"],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;

		assert.equal(outcome.value.started, false);
		assert.deepEqual(outcome.value.questions, ["which module?", "how is it tested?"]);
		assert.equal(outcome.value.record.status, "clarifying");
		assert.equal(harness.workspace.prepareCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
	});

	it("reports at most five questions", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: false,
			questions: ["1", "2", "3", "4", "5", "6", "7"],
		});
		assert.equal(outcome.ok, true);
		if (outcome.ok) assert.ok(outcome.value.questions.length <= 5);
	});

	it("keeps an unreachable goal clarifying and creates no worktree", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("rewrite the kernel in a week");

		const outcome = await service.submitClarification({
			ready: true,
			reachable: false,
			clarifiedGoal: "rewrite the kernel",
			criteria: [commandCriterion()],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;

		assert.equal(outcome.value.started, false);
		assert.equal(outcome.value.record.status, "clarifying");
		assert.ok(outcome.value.questions.some((q) => /not reachable/.test(q)));
		assert.equal(harness.workspace.prepareCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
	});

	it("keeps clarifying when a criterion has no verifier", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "make it better",
			criteria: [{ id: "c1", text: "vibes" } as never],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.record.status, "clarifying");
		assert.equal(harness.workspace.prepareCalls.length, 0);
	});

	it("starts work without a confirmation step once the goal is valid", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "raise coverage of module x to 90%",
			criteria: [commandCriterion("c1"), inspectCriterion("c2")],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.started, true);

		// Order is the contract: record (active) → worktree → session.
		const relevant = harness.log.calls.filter((call) => call !== "store.write" || true);
		const firstActiveWrite = relevant.indexOf("store.write");
		const prepare = relevant.indexOf("workspace.prepare");
		const start = relevant.indexOf("runtime.start");
		assert.ok(
			firstActiveWrite >= 0 && prepare > firstActiveWrite && start > prepare,
			relevant.join(","),
		);

		assert.equal(outcome.value.record.status, "active");
		assert.equal(outcome.value.record.worktree, "/tmp/worktrees/goal-1");
		assert.equal(outcome.value.record.branch, "goal/goal-1");
		assert.equal(harness.runtime.starts.length, 1);
		assert.equal(harness.runtime.starts[0]!.worktree, "/tmp/worktrees/goal-1");
		assert.equal(harness.runtime.starts[0]!.model, "provider/model-id");
	});

	it("pauses with a commit-or-stash blocker on a dirty checkout", async () => {
		const harness = createHarness();
		harness.workspace.outcome = {
			clean: false,
			reason:
				"the current checkout has uncommitted changes — commit or stash them before starting a goal",
		};
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "raise coverage",
			criteria: [commandCriterion()],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;

		assert.equal(outcome.value.record.status, "paused");
		assert.match(outcome.value.record.blocker ?? "", /commit or stash/i);
		assert.equal(outcome.value.record.branch, null);
		assert.equal(harness.runtime.starts.length, 0);
	});

	it("pauses when worktree creation fails, keeping nothing to clean up", async () => {
		const harness = createHarness();
		harness.workspace.prepareError = "git worktree add failed: branch already exists";
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "raise coverage",
			criteria: [commandCriterion()],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;

		assert.equal(outcome.value.record.status, "paused");
		assert.match(outcome.value.record.blocker ?? "", /branch already exists/);
		assert.equal(harness.pr.openCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
		assert.equal(harness.workspace.cleanupCalls.length, 0);
	});

	it("pauses when the fresh session cannot start", async () => {
		const harness = createHarness();
		harness.runtime.startError = "SDK unavailable";
		const service = serviceFor(harness);
		await service.start("make it better");

		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "raise coverage",
			criteria: [commandCriterion()],
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.record.status, "paused");
		assert.match(outcome.value.record.blocker ?? "", /SDK unavailable/);
	});
});

describe("/goal stop while clarifying", () => {
	it("cancels the record and creates no worktree, branch or PR", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		await service.start("make it better");

		const stopped = await service.stop();
		assert.equal(stopped.ok, true);
		assert.equal(harness.store.last().status, "cancelled");
		assert.equal(harness.workspace.prepareCalls.length, 0);
		assert.equal(harness.pr.openCalls.length, 0);
		assert.equal(harness.runtime.starts.length, 0);
	});
});

describe("one active goal per session", () => {
	it("rejects a second /goal and names the active goal id", async () => {
		const harness = createHarness();
		const service = serviceFor(harness);
		const first = await service.start("first goal");
		assert.equal(first.ok, true);
		if (!first.ok) return;

		const writesBefore = harness.store.writes.length;
		const second = await service.start("second goal");
		assert.equal(second.ok, false);
		if (!second.ok) assert.match(second.error, new RegExp(first.value.id));
		assert.equal(harness.store.writes.length, writesBefore);
		assert.equal(harness.workspace.prepareCalls.length, 0);
	});

	it("rejects a goal when another session left a non-terminal record", async () => {
		const harness = createHarness();
		harness.store.seed = [buildRecord({ id: "20260101-000000-old-goal-aaaa", status: "active" })];
		const service = serviceFor(harness);

		const started = await service.start("a new goal");
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /20260101-000000-old-goal-aaaa/);
		assert.equal(harness.store.writes.length, 0);
	});

	it("allows a new goal when the only records are terminal", async () => {
		const harness = createHarness();
		harness.store.seed = [
			buildRecord({ id: "20260101-000000-done-goal-aaaa", status: "complete" }),
			buildRecord({ id: "20260101-000001-dead-goal-bbbb", status: "cancelled" }),
		];
		const service = serviceFor(harness);

		const started = await service.start("a new goal");
		assert.equal(started.ok, true);
		if (started.ok) assert.notEqual(started.value.id, "20260101-000000-done-goal-aaaa");
		assert.equal(harness.store.writes.length, 1);
	});

	it("refuses to start when another process holds the record lock", async () => {
		const harness = createHarness();
		harness.store.acquireError = "goal lock held by pid 42";
		const service = serviceFor(harness);

		const started = await service.start("a new goal");
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /goal lock held by pid 42/);
		assert.equal(harness.store.writes.length, 0);
	});
});
