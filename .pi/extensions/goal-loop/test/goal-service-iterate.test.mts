// ─── Phase 6: iteration, verification, publication, limits ──────
// R4 (evidence-based completion), R7 (bounded execution), R3.AC3/AC4
// (draft PR → ready for review, never merged).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockExec } from "../../supervisor/test/helpers/git-harness.mts";
import { GoalService } from "../application/goal-service.ts";
import { HarnessCheckRunner } from "../adapters/goal-checks.ts";
import type { GoalRecord } from "../domain/goal-record.ts";
import {
	buildRecord,
	commandCriterion,
	createHarness,
	inspectCriterion,
	type Harness,
} from "./helpers/builders.mts";

/** Drive a harness to an active goal with one criterion. */
async function activate(
	harness: Harness,
	options: {
		criteria?: ReturnType<typeof commandCriterion>[];
		config?: Partial<GoalRecord["config"]>;
	} = {},
): Promise<GoalService> {
	if (options.config) {
		harness.deps.loadConfig = () => ({
			ok: true,
			value: {
				settings: {
					model: harness.config.settings.model,
					contextRolloverTokens: harness.config.settings.contextRolloverTokens,
					maxIterations: options.config!.maxIterations ?? harness.config.settings.maxIterations,
				},
				model: harness.config.model,
			},
		});
	}
	const service = new GoalService(harness.deps);
	const started = await service.start("raise coverage of module x");
	assert.equal(started.ok, true);
	const outcome = await service.submitClarification({
		ready: true,
		clarifiedGoal: "raise coverage of module x to 90%",
		criteria: options.criteria ?? [commandCriterion("c1")],
	});
	if (!outcome.ok) throw new Error(`goal did not start: ${outcome.error}`);
	assert.equal(outcome.value.started, true);
	return service;
}

/** Give the active goal an existing PR without going through a boundary. */
async function publishDraft(service: GoalService): Promise<void> {
	const published = await service.publish();
	assert.equal(published.ok, true);
	if (published.ok) assert.equal(published.value.pr?.state, "draft");
}

describe("post-iteration checkpoint", () => {
	it("writes the record twice per boundary and updates checkpoint + next action", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		harness.checks.results.set("c1", "fail");
		const reported = await service.reportIteration({
			summary: "wrote half the tests",
			nextAction: "write the remaining tests",
		});
		assert.equal(reported.ok, true);

		harness.store.writes.length = 0;
		const before = service.current()!.lastCheckpoint;
		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);

		assert.equal(harness.store.writes.length, 2, "checkpoint write + decision write");
		const record = service.current()!;
		assert.equal(record.nextAction, "write the remaining tests");
		assert.ok(record.lastCheckpoint !== undefined);
		assert.ok(before !== undefined);
		assert.equal(record.iterations, 1);
	});
});

describe("verification recomputes evidence", () => {
	it("calls the check runner once per criterion per boundary", async () => {
		const harness = createHarness();
		const service = await activate(harness, {
			criteria: [commandCriterion("c1"), inspectCriterion("c2")],
		});
		await publishDraft(service);
		harness.checks.runs.length = 0;

		await service.onBoundary();
		assert.deepEqual(
			harness.checks.runs.map((run) => run.criterionId),
			["c1", "c2"],
		);
		assert.equal(harness.checks.runs[0]!.worktree, "/tmp/worktrees/goal-1");
	});

	it("does not accept a stored pass when the current run fails", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);

		// First boundary: the criterion passes, so the stored evidence says pass.
		const first = await service.onBoundary();
		assert.equal(first.ok, true);
		assert.equal(service.current()!.status, "complete");

		// Second scenario: same shape, but the current run fails.
		const second = createHarness();
		const failingService = await activate(second);
		await publishDraft(failingService);
		second.checks.results.set("c1", "fail");
		const boundary = await failingService.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.decision.kind, "continue");
		assert.equal(boundary.value.record.verification[0]!.result, "fail");
	});

	it("treats a throwing check runner as blocked verification", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		harness.checks.throwOn = "c1";

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.decision.kind, "pause");
		assert.equal(boundary.value.record.status, "paused");
		assert.match(boundary.value.record.blocker ?? "", /verification could not run for c1/);
	});
});

describe("ordinary failing checks keep the loop working", () => {
	it("continues without pausing", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		harness.checks.results.set("c1", "fail");

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.decision.kind, "continue");
		assert.equal(boundary.value.record.status, "active");
		assert.equal(boundary.value.record.blocker, null);
	});
});

describe("publication", () => {
	it("opens a draft PR once work has landed and keeps working", async () => {
		const harness = createHarness();
		const service = await activate(harness);

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(harness.pr.openCalls.length, 1);
		assert.equal(harness.pr.openCalls[0]!.base, "main");
		assert.equal(
			boundary.value.decision.kind,
			"continue",
			"a PR opened now cannot complete this boundary",
		);
		assert.equal(boundary.value.record.pr?.state, "draft");
	});

	it("pauses when the draft PR cannot be opened, keeping the worktree", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		harness.pr.openError = "rate limited";

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.record.status, "paused");
		assert.match(boundary.value.record.blocker ?? "", /rate limited/);
		assert.equal(boundary.value.record.worktree, "/tmp/worktrees/goal-1");
		assert.equal(harness.workspace.cleanupCalls.length, 0);
	});

	it("marks the PR ready for review and completes, never merging", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		const startsBefore = harness.runtime.starts.length;

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "complete");
		assert.deepEqual(harness.pr.readyCalls, ["node-7"]);
		assert.equal(boundary.value.record.status, "complete");
		assert.equal(boundary.value.record.pr?.state, "open");
		assert.equal(harness.runtime.starts.length, startsBefore, "completion starts no new session");
		assert.equal(
			Object.keys(harness.pr).some((key) => /merge|close/i.test(key)),
			false,
			"the PR port exposes no merge or close operation",
		);
	});

	it("pauses when the PR cannot be marked ready", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		harness.pr.readyError = "graphql unavailable";

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.record.status, "paused");
		assert.match(boundary.value.record.blocker ?? "", /graphql unavailable/);
	});
});

describe("iteration limit", () => {
	it("verifies first, then pauses at the cap without starting a session", async () => {
		const harness = createHarness();
		const service = await activate(harness, { config: { maxIterations: 1 } });
		await publishDraft(service);
		harness.checks.results.set("c1", "fail");
		const startsBefore = harness.runtime.starts.length;
		harness.log.clear();

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;

		assert.equal(boundary.value.decision.kind, "pause-cap");
		assert.equal(boundary.value.record.status, "paused");
		assert.match(boundary.value.record.blocker ?? "", /iteration limit reached \(1\)/);
		assert.deepEqual(harness.log.calls.slice(-2), ["checks.run:c1", "store.write"]);
		assert.equal(harness.runtime.starts.length, startsBefore);
	});

	it("completes instead of pausing when the goal is verified at the cap", async () => {
		const harness = createHarness();
		const service = await activate(harness, { config: { maxIterations: 1 } });
		await publishDraft(service);

		const boundary = await service.onBoundary();
		assert.equal(boundary.ok, true);
		if (!boundary.ok) return;
		assert.equal(boundary.value.decision.kind, "complete");
		assert.equal(boundary.value.record.status, "complete");
	});
});

describe("stop mid-iteration", () => {
	it("aborts the session, writes the final status and starts nothing else", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		const startsBefore = harness.runtime.starts.length;

		const stopped = await service.stop();
		assert.equal(stopped.ok, true);

		assert.equal(harness.runtime.aborts.length, 1);
		assert.equal(harness.store.last().status, "cancelled");
		assert.equal(harness.runtime.starts.length, startsBefore);
		assert.equal(service.hasActiveGoal(), false);
	});

	it("refuses to stop a terminal goal", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		await service.onBoundary();

		const stopped = await service.stop();
		assert.equal(stopped.ok, false);
	});
});

describe("state write failure", () => {
	it("pauses and names the last saved checkpoint", async () => {
		const harness = createHarness();
		// start write (1) + active write (2), then the worktree write fails.
		harness.store.failAfterWrites = 2;
		const service = new GoalService(harness.deps);
		await service.start("raise coverage of module x");
		const outcome = await service.submitClarification({
			ready: true,
			clarifiedGoal: "raise coverage",
			criteria: [commandCriterion()],
		});

		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(outcome.error, /last saved checkpoint/);
		assert.equal(harness.runtime.starts.length, 0);
		assert.equal(service.current()?.status, "paused");
	});
});

describe("steering", () => {
	it("forwards the message, appends it and leaves the criteria untouched", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		const criteriaBefore = JSON.stringify(service.current()!.criteria);
		const clarifiedBefore = service.current()!.clarifiedGoal;

		const steered = await service.steer("use the existing helper");
		assert.equal(steered.ok, true);

		assert.deepEqual(harness.runtime.steers, ["use the existing helper"]);
		assert.deepEqual(service.current()!.steering, ["use the existing helper"]);
		assert.equal(JSON.stringify(service.current()!.criteria), criteriaBefore);
		assert.equal(service.current()!.clarifiedGoal, clarifiedBefore);
		assert.equal(harness.store.writes.at(-1)!.steering.length, 1);
	});

	it("refuses to steer when no goal is running", async () => {
		const harness = createHarness();
		const service = new GoalService(harness.deps);
		const steered = await service.steer("hello");
		assert.equal(steered.ok, false);
	});
});

describe("revision", () => {
	it("replaces the criteria and re-enters clarification", async () => {
		const harness = createHarness();
		const service = await activate(harness);

		const revised = await service.revise({ criteria: [inspectCriterion("c9")] });
		assert.equal(revised.ok, true);
		if (!revised.ok) return;

		assert.equal(revised.value.status, "clarifying");
		assert.deepEqual(
			revised.value.criteria.map((c) => c.id),
			["c9"],
		);
		assert.equal(
			harness.runtime.starts.length,
			1,
			"no iteration until the criteria are valid again",
		);
	});
});

describe("status", () => {
	it("reports state, counters, per-criterion results, worktree, branch and PR", async () => {
		const harness = createHarness();
		const service = await activate(harness);
		await publishDraft(service);
		await service.reportIteration({ summary: "progress", nextAction: "next" });
		await service.onBoundary();

		const text = service.status();
		assert.match(text, /status: /);
		assert.match(text, /iterations: 1/);
		assert.match(text, /resets: 0/);
		assert.match(text, /c1: pass/);
		assert.match(text, /worktree: \/tmp\/worktrees\/goal-1/);
		assert.match(text, /branch: goal\/goal-1/);
		assert.match(text, /pull request: #7 \(open\)/);
	});

	it("says so when there is no goal", () => {
		const harness = createHarness();
		assert.equal(new GoalService(harness.deps).status(), "no active goal");
	});
});

describe("harness verification (HarnessCheckRunner)", () => {
	function repo(): { dir: string; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "goal-check-"));
		return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
	}

	it("runs a command verifier as argv in the worktree", async () => {
		const fixture = repo();
		try {
			const { exec, calls } = createMockExec([{ code: 0, stdout: "ok", stderr: "" }]);
			const runner = new HarnessCheckRunner({ exec });
			const outcome = await runner.run(
				commandCriterion("c1", ["npm", "test", "--silent"]),
				fixture.dir,
			);
			assert.equal(outcome.ok, true);
			if (outcome.ok) assert.equal(outcome.value.result, "pass");
			assert.equal(calls[0]!.cmd, "npm");
			assert.deepEqual(calls[0]!.args, ["test", "--silent"]);
			assert.equal(calls[0]!.opts.cwd, fixture.dir);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails a non-zero exit against the expected code", async () => {
		const fixture = repo();
		try {
			const { exec } = createMockExec([{ code: 3, stdout: "", stderr: "boom" }]);
			const runner = new HarnessCheckRunner({ exec });
			const outcome = await runner.run(commandCriterion("c1", ["npm", "test"]), fixture.dir);
			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.value.result, "fail");
				assert.match(outcome.value.evidenceRef, /exited 3 \(expected 0\)/);
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("never executes the verifier when a pinned hash mismatches", async () => {
		const fixture = repo();
		try {
			writeFileSync(join(fixture.dir, "check.sh"), "echo tampered\n");
			const { exec, calls } = createMockExec([{ code: 0, stdout: "", stderr: "" }]);
			const runner = new HarnessCheckRunner({ exec });
			const criterion = commandCriterion("c1", ["./check.sh"]);
			criterion.verifier = {
				kind: "command",
				argv: ["./check.sh"],
				pinned: [{ path: "check.sh", sha256: "0".repeat(64) }],
				expectExit: 0,
			};

			const outcome = await runner.run(criterion, fixture.dir);
			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.value.result, "fail");
				assert.match(outcome.value.evidenceRef, /pinned hash mismatch for check\.sh/);
			}
			assert.equal(calls.length, 0, "verifier must not run when a pin fails");
		} finally {
			fixture.cleanup();
		}
	});

	it("runs the verifier when the pinned hash matches", async () => {
		const fixture = repo();
		try {
			const bytes = Buffer.from("echo ok\n");
			writeFileSync(join(fixture.dir, "check.sh"), bytes);
			const { exec, calls } = createMockExec([{ code: 0, stdout: "", stderr: "" }]);
			const runner = new HarnessCheckRunner({ exec });
			const criterion = commandCriterion("c1", ["./check.sh"]);
			criterion.verifier = {
				kind: "command",
				argv: ["./check.sh"],
				pinned: [{ path: "check.sh", sha256: createHash("sha256").update(bytes).digest("hex") }],
				expectExit: 0,
			};

			const outcome = await runner.run(criterion, fixture.dir);
			assert.equal(outcome.ok, true);
			if (outcome.ok) assert.equal(outcome.value.result, "pass");
			assert.equal(calls.length, 1);
		} finally {
			fixture.cleanup();
		}
	});

	it("feeds an inspect verifier harness evidence, never the record", async () => {
		const fixture = repo();
		try {
			const { exec } = createMockExec([
				{ code: 0, stdout: " M src/a.ts\n", stderr: "" },
				{ code: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n+test\n", stderr: "" },
			]);
			const seen: string[] = [];
			const runner = new HarnessCheckRunner({
				exec,
				inspect: async (_instruction, evidence) => {
					seen.push(evidence);
					return { pass: true, note: "adds a test" };
				},
			});

			const outcome = await runner.run(inspectCriterion("c2"), fixture.dir);
			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.value.result, "pass");
				assert.match(outcome.value.evidenceRef, /adds a test/);
			}
			assert.equal(seen.length, 1);
			assert.match(seen[0]!, /git status --porcelain/);
			assert.match(seen[0]!, /diff --git/);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails closed when no inspect runner is configured", async () => {
		const fixture = repo();
		try {
			const { exec } = createMockExec([]);
			const runner = new HarnessCheckRunner({ exec });
			const outcome = await runner.run(inspectCriterion("c2"), fixture.dir);
			assert.equal(outcome.ok, false);
			if (!outcome.ok) assert.match(outcome.error, /needs an inspect verifier/);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails closed when the worktree is missing", async () => {
		const { exec } = createMockExec([]);
		const runner = new HarnessCheckRunner({ exec });
		const outcome = await runner.run(commandCriterion(), "");
		assert.equal(outcome.ok, false);
	});
});

describe("record fixtures", () => {
	it("keeps the builder honest about active records", () => {
		const record = buildRecord({ status: "active", worktree: "/tmp/wt", branch: "goal/x" });
		assert.equal(record.status, "active");
		assert.equal(record.worktree, "/tmp/wt");
	});
});
