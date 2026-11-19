// ─── Phase 1: goal record entity + status invariants ─────────────
// The record is the loop's only durable state (R2). Everything here is pure:
// no fs, no git, no pi.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ACTIVE_STATUSES,
	assertTransition,
	canTransition,
	findActiveRecord,
	isActiveStatus,
	GOAL_STATUSES,
	type GoalRecord,
	type GoalStatus,
} from "../domain/goal-record.ts";
import {
	assertSafeGoalId,
	createGoalRecord,
	makeGoalId,
	slugifyGoalDescription,
} from "../domain/goal-record-id.ts";
import { extractAgentSection, serializeGoalRecord } from "../domain/goal-record-markdown.ts";
import { parseGoalRecord } from "../domain/goal-record-parse.ts";
import { buildRecord, DEFAULT_CONFIG } from "./helpers/builders.mts";

describe("goal record entity", () => {
	it("builds a clarifying record from /goal <text>", () => {
		const record = createGoalRecord({
			id: "20260102-030405-add-a-feature-abcd",
			request: "add a feature",
			config: DEFAULT_CONFIG,
			now: new Date("2026-01-02T03:04:05.000Z"),
		});

		assert.equal(record.status, "clarifying");
		assert.equal(record.iterations, 0);
		assert.equal(record.windowIterations, 0);
		assert.equal(record.resets, 0);
		assert.equal(record.generation, 0);
		assert.deepEqual(record.criteria, []);
		assert.deepEqual(record.verification, []);
		assert.equal(record.worktree, null);
		assert.equal(record.branch, null);
		assert.equal(record.pr, null);
		assert.equal(record.blocker, null);
		assert.equal(record.compactionSeen, false);
		assert.equal(record.inFlight, false);
		assert.deepEqual(record.config, DEFAULT_CONFIG);
	});
});

describe("goal status transitions", () => {
	const allowed: Array<[GoalStatus, GoalStatus]> = [
		["clarifying", "active"],
		["clarifying", "cancelled"],
		["active", "verifying"],
		["verifying", "active"],
		["active", "paused"],
		["paused", "active"],
		["verifying", "complete"],
		["active", "cancelled"],
	];

	for (const [from, to] of allowed) {
		it(`allows ${from} → ${to}`, () => {
			assert.equal(canTransition(from, to), true);
			assert.doesNotThrow(() => assertTransition(from, to));
		});
	}

	it("rejects every transition out of a terminal status and names both statuses", () => {
		assert.throws(
			() => assertTransition("complete", "active"),
			(error: Error) => error.message.includes("complete") && error.message.includes("active"),
		);
		assert.throws(
			() => assertTransition("cancelled", "active"),
			(error: Error) => error.message.includes("cancelled") && error.message.includes("active"),
		);
		assert.throws(
			() => assertTransition("complete", "paused"),
			(error: Error) => error.message.includes("complete") && error.message.includes("paused"),
		);
	});

	it("reaches complete only from verifying", () => {
		assert.throws(() => assertTransition("clarifying", "complete"));
		assert.throws(() => assertTransition("active", "complete"));
		assert.doesNotThrow(() => assertTransition("verifying", "complete"));
	});

	it("rejects an undeclared edge", () => {
		assert.throws(() => assertTransition("clarifying", "paused"));
		assert.equal(canTransition("clarifying", "paused"), false);
	});
});

describe("goal record serialization", () => {
	it("round-trips every R2.AC2 field", () => {
		const record: GoalRecord = buildRecord({
			status: "active",
			clarifiedGoal: "make the widget measurable",
			criteria: [
				{
					id: "c1",
					text: "tests pass",
					verifier: {
						kind: "command",
						argv: ["npm", "test"],
						pinned: [{ path: "scripts/check.sh", sha256: "deadbeef" }],
						expectExit: 0,
					},
				},
				{
					id: "c2",
					text: "diff reviewed",
					verifier: { kind: "inspect", instruction: "the diff adds a test" },
				},
			],
			verification: [
				{
					criterionId: "c1",
					result: "pass",
					evidenceRef: "`npm test` exited 0",
					checkedAt: "2026-01-02T03:05:00.000Z",
				},
			],
			iterations: 3,
			windowIterations: 2,
			resets: 1,
			generation: 1,
			lastCheckpoint: "2026-01-02T03:06:00.000Z",
			nextAction: "fix the flaky test",
			worktree: "/tmp/worktrees/goal-1",
			branch: "goal/20260102-030405-add-a-feature-abcd",
			pr: { number: 7, nodeId: "node-7", state: "draft" },
			blocker: "waiting for review",
			steering: ["use the existing helper"],
			compactionSeen: true,
			inFlight: true,
		});

		const parsed = parseGoalRecord(serializeGoalRecord(record));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.value, record);
	});

	it("regenerates the managed section but preserves the agent section", () => {
		const record = buildRecord({ status: "active", iterations: 4 });
		const first = serializeGoalRecord(record, "my note");
		assert.match(first, /status: active/);
		assert.match(first, /<!-- loop:managed -->/);
		assert.equal(extractAgentSection(first), "my note");

		const second = serializeGoalRecord({ ...record, iterations: 9 }, extractAgentSection(first));
		assert.match(second, /- iterations: 9/);
		assert.doesNotMatch(second, /- iterations: 4/);
		assert.equal(extractAgentSection(second), "my note");
	});

	it("fails closed on truncated front matter", () => {
		const parsed = parseGoalRecord('---\nid: "x"\nstatus: clarifying\n');
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /truncated front matter/);
	});

	it("fails closed on a missing required key", () => {
		const record = buildRecord();
		const text = serializeGoalRecord(record).replace(/- iteration.*\n/g, "");
		const withoutIterations = text
			.split("\n")
			.filter((line) => !line.startsWith("iterations:"))
			.join("\n");
		const parsed = parseGoalRecord(withoutIterations);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /missing required front-matter key "iterations"/);
	});

	it("fails closed on an unknown status", () => {
		const text = serializeGoalRecord(buildRecord()).replace(
			'status: "clarifying"',
			'status: "exploded"',
		);
		const parsed = parseGoalRecord(text);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /unknown goal status/);
	});

	it("fails closed on a non-JSON front-matter value", () => {
		const text = serializeGoalRecord(buildRecord()).replace(
			'request: "add a feature"',
			"request: add a feature",
		);
		const parsed = parseGoalRecord(text);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /not valid JSON/);
	});
});

describe("goal ids", () => {
	it("uses yyyymmdd-hhmmss-<slug>-<rand4>", () => {
		const id = makeGoalId("Add a Feature!", new Date("2026-01-02T03:04:05.000Z"), () => "zzzz");
		assert.equal(id, "20260102-030405-add-a-feature-zzzz");
	});

	it("truncates the slug to 50 characters", () => {
		const slug = slugifyGoalDescription("a".repeat(120));
		assert.equal(slug.length, 50);
	});

	it("rejects an id containing / or .. and sanitizes them out of a description", () => {
		assert.throws(() => assertSafeGoalId("a/b"), /path separator/);
		assert.throws(() => assertSafeGoalId("a..b"), /\.\./);
		const id = makeGoalId("a/b..c", new Date("2026-01-02T03:04:05.000Z"), () => "abcd");
		assert.equal(id, "20260102-030405-a-b-c-abcd");
	});

	it("gives two records from the same description in the same second different ids", () => {
		const now = new Date("2026-01-02T03:04:05.000Z");
		const first = makeGoalId("add a feature", now);
		const second = makeGoalId("add a feature", now);
		assert.notEqual(first, second);
	});
});

describe("active goal scan", () => {
	it("treats complete and cancelled as terminal for the scan but keeps them on disk", () => {
		assert.deepEqual([...ACTIVE_STATUSES].sort(), ["active", "clarifying", "paused", "verifying"]);
		for (const status of GOAL_STATUSES) {
			assert.equal(
				isActiveStatus(status),
				status !== "complete" && status !== "cancelled",
				`${status} activity`,
			);
		}
	});

	it("returns the single non-terminal record", () => {
		const active = buildRecord({ id: "a-1", status: "verifying" });
		const done = buildRecord({ id: "b-2", status: "complete" });
		const scan = findActiveRecord([done, active]);
		assert.equal(scan.ok, true);
		if (scan.ok) assert.equal(scan.value?.id, "a-1");
	});

	it("returns null when only terminal records exist", () => {
		const scan = findActiveRecord([
			buildRecord({ id: "a-1", status: "complete" }),
			buildRecord({ id: "b-2", status: "cancelled" }),
		]);
		assert.equal(scan.ok, true);
		if (scan.ok) assert.equal(scan.value, null);
	});

	it("refuses two simultaneous active goals", () => {
		const scan = findActiveRecord([
			buildRecord({ id: "a-1", status: "active" }),
			buildRecord({ id: "b-2", status: "clarifying" }),
		]);
		assert.equal(scan.ok, false);
		if (!scan.ok) assert.match(scan.error, /multiple active goals/);
	});
});
