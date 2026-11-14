// ─── Tests: checks/ci-gating.ts — PR-aware CI polling ────────────────
// Issue #1828: the gate polls the open PR head SHA (not `origin/<branch>`)
// and classifies check runs in one pure function. All `pi.exec` calls are
// stubbed and every wait is injected — no real `gh`, no real timers.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/ci-gating.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	classifyCheckRuns,
	pollCiChecks,
	type CiCheckInfo,
	type PollCiChecksOptions,
} from "../../checks/ci-gating.ts";

// ─── Fixtures ──────────────────────────────────────────────────────

const REPO = "owner/repo";
const OWNER = "owner";
const BRANCH = "feat/issue-1828";
const HEAD_SHA = "prheadsha1234";

interface ExecCall {
	cmd: string;
	args: string[];
	cwd?: string;
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

type Responder = (call: ExecCall) => ExecResult;

/** `pi.exec` stub: rejects on non-zero exit code, like the real adapter. */
function createMockPi(respond: Responder, calls: ExecCall[] = []): ExtensionAPI {
	return {
		exec: (async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
			const call: ExecCall = { cmd, args: args ?? [], cwd: opts?.cwd as string | undefined };
			calls.push(call);
			const result = respond(call);
			if (result.code !== 0) {
				throw new Error(result.stderr || `exit code ${result.code}`);
			}
			return result;
		}) as unknown as ExtensionAPI["exec"],
	} as unknown as ExtensionAPI;
}

/** The fake clock also proves it satisfies the module's injection seam. */
interface FakeClock extends PollCiChecksOptions {
	now: () => number;
	sleeps: number[];
}

/** Deterministic clock — sleeping advances virtual time instead of real time. */
function makeClock(): FakeClock {
	let t = 0;
	const sleeps: number[] = [];
	return {
		nowFn: () => t,
		sleepFn: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
		now: () => t,
		sleeps,
	};
}

const isPullsCall = (call: ExecCall): boolean =>
	call.cmd === "gh" && call.args.some((a) => a.includes("/pulls?"));

const isCheckRunsCall = (call: ExecCall): boolean =>
	call.cmd === "gh" && call.args.some((a) => a.includes("/check-runs"));

function pullsOk(sha: string = HEAD_SHA): ExecResult {
	return { code: 0, stdout: JSON.stringify([{ number: 7, head: { sha } }]), stderr: "" };
}

const PULLS_NONE: ExecResult = { code: 0, stdout: "[]", stderr: "" };

function checkRun(name: string, status: string, conclusion: string | null, id = 1): string {
	return JSON.stringify({ id, name, status, conclusion });
}

function checkRunsResult(...lines: string[]): ExecResult {
	return { code: 0, stdout: lines.join("\n"), stderr: "" };
}

const EMPTY_CHECK_RUNS: ExecResult = { code: 0, stdout: "", stderr: "" };

/** Pulls response first, then one check-runs response per poll. */
function piForPolls(
	pulls: ExecResult,
	checkRuns: ExecResult | ((pollIndex: number) => ExecResult),
	calls: ExecCall[] = [],
): ExtensionAPI {
	let pollIndex = 0;
	return createMockPi((call) => {
		if (isPullsCall(call)) return pulls;
		const result = typeof checkRuns === "function" ? checkRuns(pollIndex) : checkRuns;
		pollIndex++;
		return result;
	}, calls);
}

const ciCheck = (name: string, status: string, conclusion: string | null): CiCheckInfo => ({
	name,
	status,
	conclusion,
});

// ─── Phase 1: classifyCheckRuns — pure classification ──────────────

describe("classifyCheckRuns — pure classification", () => {
	it("(entity) empty list → unconfigured with no failing checks", () => {
		assert.deepEqual(classifyCheckRuns([]), { status: "unconfigured", failingChecks: [] });
	});

	it("(entity) all completed/success → passing", () => {
		const result = classifyCheckRuns([
			ciCheck("build", "completed", "success"),
			ciCheck("lint", "completed", "success"),
		]);
		assert.deepEqual(result, { status: "passing", failingChecks: [] });
	});

	it("(entity) success + skipped + neutral → passing (AC2 tolerates non-blocking)", () => {
		const result = classifyCheckRuns([
			ciCheck("build", "completed", "success"),
			ciCheck("docs", "completed", "skipped"),
			ciCheck("optional", "completed", "neutral"),
		]);
		assert.deepEqual(result, { status: "passing", failingChecks: [] });
	});

	it("(entity) failure → failing naming exactly that check", () => {
		const result = classifyCheckRuns([ciCheck("build", "completed", "failure")]);
		assert.deepEqual(result, { status: "failing", failingChecks: ["build"] });
	});

	for (const conclusion of ["cancelled", "action_required", "timed_out", "stale"]) {
		it(`(entity) ${conclusion} → failing naming that check (AC3)`, () => {
			const result = classifyCheckRuns([ciCheck("deploy", "completed", conclusion)]);
			assert.deepEqual(result, { status: "failing", failingChecks: ["deploy"] });
		});
	}

	it("(entity) 3 passing + 1 failure → failing with exactly the failing name", () => {
		const result = classifyCheckRuns([
			ciCheck("a", "completed", "success"),
			ciCheck("b", "completed", "success"),
			ciCheck("broken", "completed", "failure"),
			ciCheck("c", "completed", "success"),
		]);
		assert.deepEqual(result, { status: "failing", failingChecks: ["broken"] });
	});

	it("(entity) failure + queued check → failing (failure short-circuits pending)", () => {
		const result = classifyCheckRuns([
			ciCheck("build", "completed", "failure"),
			ciCheck("lint", "queued", null),
		]);
		assert.deepEqual(result, { status: "failing", failingChecks: ["build"] });
	});

	it("(entity) in_progress with null conclusion → pending", () => {
		assert.deepEqual(classifyCheckRuns([ciCheck("build", "in_progress", null)]), {
			status: "pending",
			failingChecks: [],
		});
	});

	it("(entity) queued with success conclusion → pending (requires completed status)", () => {
		assert.deepEqual(classifyCheckRuns([ciCheck("build", "queued", "success")]), {
			status: "pending",
			failingChecks: [],
		});
	});

	it("(entity) unknown conclusion → pending, never passing", () => {
		assert.deepEqual(classifyCheckRuns([ciCheck("build", "completed", "weird_unknown")]), {
			status: "pending",
			failingChecks: [],
		});
	});

	it("(entity) completed with null conclusion → pending", () => {
		assert.deepEqual(classifyCheckRuns([ciCheck("build", "completed", null)]), {
			status: "pending",
			failingChecks: [],
		});
	});

	it("(entity) pure — same input twice returns equal results and mutates nothing", () => {
		const input: CiCheckInfo[] = [
			ciCheck("build", "completed", "failure"),
			ciCheck("lint", "completed", "success"),
		];
		const snapshot = JSON.parse(JSON.stringify(input)) as CiCheckInfo[];
		const first = classifyCheckRuns(input);
		const second = classifyCheckRuns(input);
		assert.deepEqual(first, second);
		assert.deepEqual(input, snapshot, "input array must not be mutated");
	});
});

// ─── Phase 2: pollCiChecks — PR-head resolution ────────────────────

describe("pollCiChecks — PR head resolution and polling", () => {
	it("(adapter) resolves the open PR head SHA and polls that SHA with pagination", async () => {
		const calls: ExecCall[] = [];
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(checkRun("build", "completed", "success", 11)),
			calls,
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "passing");
		assert.equal(calls[0]!.cmd, "gh");
		assert.deepEqual(calls[0]!.args, [
			"api",
			`repos/${REPO}/pulls?head=${OWNER}:${BRANCH}&state=open&per_page=1`,
		]);
		const poll = calls.find(isCheckRunsCall)!;
		assert.ok(poll, "expected a check-runs exec call");
		assert.equal(poll.args[0], "api");
		assert.ok(poll.args.includes("--paginate"), "check-runs call must paginate");
		assert.ok(
			poll.args.includes(`repos/${REPO}/commits/${HEAD_SHA}/check-runs?per_page=100&filter=latest`),
			`check-runs URL must target the PR head SHA, got: ${poll.args.join(" ")}`,
		);
	});

	it("(adapter) never resolves origin/<branch> (AC1 regression guard)", async () => {
		const calls: ExecCall[] = [];
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(checkRun("build", "completed", "success")),
			calls,
		);

		await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		for (const call of calls) {
			const flattened = `${call.cmd} ${call.args.join(" ")}`;
			assert.ok(!flattened.includes("origin/"), `must not touch origin/<branch>: ${flattened}`);
			assert.ok(!flattened.startsWith("git "), `must not shell out to git: ${flattened}`);
		}
	});

	it("(adapter) no open PR → error naming the branch, no check-runs call", async () => {
		const calls: ExecCall[] = [];
		const clock = makeClock();
		const pi = piForPolls(
			PULLS_NONE,
			checkRunsResult(checkRun("build", "completed", "success")),
			calls,
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "error");
		assert.ok(result.message.includes(BRANCH), `message must name the branch: ${result.message}`);
		assert.match(result.message.toLowerCase(), /no open pull request/);
		assert.equal(calls.filter(isCheckRunsCall).length, 0, "must not poll check runs without a PR");
		assert.equal(clock.sleeps.length, 0, "must not wait when there is no PR to poll");
	});

	it("(adapter) malformed PR JSON → error (no fail-open)", async () => {
		const clock = makeClock();
		const pi = piForPolls({ code: 0, stdout: "not-json", stderr: "" }, EMPTY_CHECK_RUNS);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "error");
		assert.ok(result.message.length > 0);
	});

	it("(adapter) gh rejects on the PR lookup → error", async () => {
		const clock = makeClock();
		const pi = createMockPi(() => ({ code: 1, stdout: "", stderr: "HTTP 403: Forbidden" }));

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "error");
		assert.ok(result.message.length > 0);
	});

	it("(adapter) no checks after the grace window → unconfigured (AC4)", async () => {
		const clock = makeClock();
		const pi = piForPolls(pullsOk(), EMPTY_CHECK_RUNS);

		const result = await pollCiChecks(pi, BRANCH, REPO, 600, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			unconfiguredGraceMs: 60_000,
		});

		assert.equal(result.status, "unconfigured");
		assert.deepEqual(result.checks, []);
		assert.deepEqual(result.failingChecks, []);
		assert.ok(clock.now() >= 60_000, "grace window must elapse before unconfigured");
	});

	it("(adapter) checks registering inside the grace window are picked up", async () => {
		const clock = makeClock();
		const pi = piForPolls(pullsOk(), (pollIndex) =>
			pollIndex === 0
				? EMPTY_CHECK_RUNS
				: checkRunsResult(checkRun("build", "completed", "success")),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 600, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			unconfiguredGraceMs: 60_000,
		});

		assert.equal(result.status, "passing");
		assert.equal(result.checks.length, 1);
	});

	it("(adapter) one unparseable line → error, never passing", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(checkRun("build", "completed", "success"), "{not json"),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "error");
	});

	it("(adapter) paginated output keeps every line and finds failures past the first page", async () => {
		const clock = makeClock();
		const lines: string[] = [];
		for (let i = 0; i < 149; i++) {
			lines.push(checkRun(`ok-${i}`, "completed", "success", i + 1));
		}
		lines.push(checkRun("page-two-broken", "completed", "failure", 999));
		const pi = piForPolls(pullsOk(), checkRunsResult(...lines));

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "failing");
		assert.deepEqual(result.failingChecks, ["page-two-broken"]);
		assert.equal(result.checks.length, 150, "every parsed check line must be retained");
	});

	it("(adapter) duplicate check name across pages counted once in failingChecks", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(
				checkRun("build", "completed", "failure", 1),
				checkRun("lint", "completed", "success", 2),
				checkRun("build", "completed", "failure", 3),
			),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "failing");
		assert.deepEqual(result.failingChecks, ["build"]);
	});

	it("(adapter) all success → passing with the check count in the message", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(
				checkRun("build", "completed", "success", 1),
				checkRun("lint", "completed", "success", 2),
				checkRun("test", "completed", "success", 3),
			),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "passing");
		assert.equal(result.checks.length, 3);
		assert.ok(
			result.message.includes("3"),
			`message must contain the check count: ${result.message}`,
		);
	});

	it("(adapter) failure → failing, names in failingChecks and in the message (AC3)", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(),
			checkRunsResult(
				checkRun("build", "completed", "failure", 1),
				checkRun("lint", "completed", "success", 2),
				checkRun("e2e", "completed", "timed_out", 3),
			),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "failing");
		assert.deepEqual(result.failingChecks, ["build", "e2e"]);
		assert.ok(result.message.includes("build"), `message must name build: ${result.message}`);
		assert.ok(result.message.includes("e2e"), `message must name e2e: ${result.message}`);
	});

	it("(adapter) gh rejects on a check-runs poll → error", async () => {
		const clock = makeClock();
		let polls = 0;
		const pi = createMockPi((call) => {
			if (isPullsCall(call)) return pullsOk();
			polls++;
			return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
		});

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, clock);

		assert.equal(result.status, "error");
		assert.equal(polls, 1);
	});

	it("(adapter) checks still in progress past the deadline → pending on virtual time only", async () => {
		const clock = makeClock();
		const pi = piForPolls(pullsOk(), checkRunsResult(checkRun("build", "in_progress", null)));

		const realStart = Date.now();
		const result = await pollCiChecks(pi, BRANCH, REPO, 30, clock);
		const realElapsed = Date.now() - realStart;

		assert.equal(result.status, "pending");
		assert.ok(clock.now() >= 30_000, `virtual clock must reach the deadline, got ${clock.now()}ms`);
		assert.ok(clock.sleeps.length >= 2, "must poll at least twice before giving up");
		assert.ok(realElapsed < 1_000, `must not wait on the real clock, waited ${realElapsed}ms`);
	});

	it("(adapter) timeout shorter than the grace window still reports unconfigured", async () => {
		const clock = makeClock();
		const pi = piForPolls(pullsOk(), EMPTY_CHECK_RUNS);

		const result = await pollCiChecks(pi, BRANCH, REPO, 30, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			unconfiguredGraceMs: 60_000,
		});

		assert.equal(result.status, "unconfigured", "a repo without CI must not hang (AC4)");
	});
});
