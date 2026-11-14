// ─── Tests: checks/ci-gating.ts — expected head SHA pinning (issue #1829) ──
// The gate must classify only the commit the developer just pushed while
// polling. A resolved PR head that differs from `expectedHeadSha` returns
// `pending` immediately — never `passing`/`unconfigured` on a stale commit —
// so a red push cannot slip past the audit transition.
//
// Split out of ci-gating.test.mts to keep both files under the 500-segment
// long-file ceiling. Every `pi.exec` call is stubbed and every wait is
// injected: no real `gh`, no real timers.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/ci-gating-expected-sha.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pollCiChecks, type PollCiChecksOptions } from "../../checks/ci-gating.ts";

// ─── Fixtures ──────────────────────────────────────────────────────

const REPO = "owner/repo";
const BRANCH = "feat/issue-1829";
const PUSHED = "pushedcommitsha1";
const STALE = "staleheadsha2222";

interface ExecCall {
	cmd: string;
	args: string[];
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** `pi.exec` stub: rejects on non-zero exit code, like the real adapter. */
function createMockPi(
	respond: (call: ExecCall) => ExecResult,
	calls: ExecCall[] = [],
): ExtensionAPI {
	return {
		exec: (async (cmd: string, args: string[]) => {
			const call: ExecCall = { cmd, args: args ?? [] };
			calls.push(call);
			const result = respond(call);
			if (result.code !== 0) {
				throw new Error(result.stderr || `exit code ${result.code}`);
			}
			return result;
		}) as unknown as ExtensionAPI["exec"],
	} as unknown as ExtensionAPI;
}

/** Deterministic clock — sleeping advances virtual time instead of real time. */
function makeClock(): PollCiChecksOptions & { now: () => number } {
	let t = 0;
	return {
		nowFn: () => t,
		sleepFn: async (ms: number) => {
			t += ms;
		},
		now: () => t,
	};
}

const isPullsCall = (call: ExecCall): boolean =>
	call.cmd === "gh" && call.args.some((a) => a.includes("/pulls?"));

const isCheckRunsCall = (call: ExecCall): boolean =>
	call.cmd === "gh" && call.args.some((a) => a.includes("/check-runs"));

function pullsOk(sha: string): ExecResult {
	return { code: 0, stdout: JSON.stringify([{ number: 7, head: { sha } }]), stderr: "" };
}

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
	checkRuns: ExecResult,
	calls: ExecCall[] = [],
): ExtensionAPI {
	return createMockPi((call) => (isPullsCall(call) ? pulls : checkRuns), calls);
}

// ─── Phase 1 (issue #1829): expected head SHA pinning ──────────────

describe("pollCiChecks — expected head SHA (issue #1829)", () => {
	it("(adapter) resolved head equals expectedHeadSha → normal classification", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(PUSHED),
			checkRunsResult(checkRun("build", "completed", "success")),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			expectedHeadSha: PUSHED,
		});

		assert.equal(result.status, "passing");
	});

	it("(adapter) resolved head differs from expectedHeadSha → pending naming both SHAs, zero check-runs calls", async () => {
		const calls: ExecCall[] = [];
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(STALE),
			checkRunsResult(checkRun("build", "completed", "success")),
			calls,
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			expectedHeadSha: PUSHED,
		});

		assert.equal(result.status, "pending");
		assert.ok(
			result.message.includes(PUSHED),
			`message must name the pushed SHA: ${result.message}`,
		);
		assert.ok(
			result.message.includes(STALE),
			`message must name the polled SHA: ${result.message}`,
		);
		assert.equal(calls.filter(isCheckRunsCall).length, 0, "must not classify a stale commit");
		assert.deepEqual(result.failingChecks, []);
	});

	it("(adapter) head mismatch past the grace window with zero checks → pending, never unconfigured", async () => {
		const clock = makeClock();
		const pi = piForPolls(pullsOk(STALE), EMPTY_CHECK_RUNS);

		const result = await pollCiChecks(pi, BRANCH, REPO, 600, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			unconfiguredGraceMs: 60_000,
			expectedHeadSha: PUSHED,
		});

		assert.equal(result.status, "pending");
		assert.equal(clock.now(), 0, "a mismatch is decided before any waiting");
	});

	it("(adapter) head mismatch while the polled SHA is red → pending (mismatch wins over failing)", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(STALE),
			checkRunsResult(checkRun("build", "completed", "failure")),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			expectedHeadSha: PUSHED,
		});

		assert.equal(result.status, "pending");
		assert.deepEqual(
			result.failingChecks,
			[],
			"a stale commit's red checks are not attributed to this push",
		);
	});

	it("(adapter) empty-string expectedHeadSha → error naming the missing SHA", async () => {
		let polls = 0;
		const clock = makeClock();
		const pi = createMockPi(() => {
			polls++;
			return pullsOk(PUSHED);
		});

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
			expectedHeadSha: "",
		});

		assert.equal(result.status, "error");
		assert.match(result.message.toLowerCase(), /sha/);
		assert.equal(polls, 0, "an unusable expectation must not poll anything");
	});

	it("(adapter) omitted expectedHeadSha → unchanged classification (regression)", async () => {
		const clock = makeClock();
		const pi = piForPolls(
			pullsOk(STALE),
			checkRunsResult(checkRun("build", "completed", "success")),
		);

		const result = await pollCiChecks(pi, BRANCH, REPO, 60, {
			sleepFn: clock.sleepFn,
			nowFn: clock.nowFn,
		});

		assert.equal(result.status, "passing");
	});
});
