// ─── Tests: agent/runner/deadline.ts — wall-clock watchdog ────────
// Pure watchdog tests (no child_process mock needed — the target is a
// fake killGroup). Real timers with short durations + generous margins
// so timing assertions hold on loaded CI runners.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/agent-deadline.test.mts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { armDeadlineWatchdog, DEFAULT_KILL_GRACE_MS } from "../agent/runner/deadline.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake killGroup target — typed to satisfy ChildHandle's Pick. */
function fakeTarget(): {
	killGroup: ReturnType<typeof mock.fn<(sig: NodeJS.Signals) => NodeJS.ErrnoException | null>>;
} {
	return { killGroup: mock.fn<(sig: NodeJS.Signals) => NodeJS.ErrnoException | null>() };
}

function signalsFired(target: {
	killGroup: ReturnType<typeof mock.fn<(sig: NodeJS.Signals) => NodeJS.ErrnoException | null>>;
}): string[] {
	return target.killGroup.mock.calls.map((c) => c.arguments[0] as string);
}

describe("armDeadlineWatchdog — escalation ladder", () => {
	it("SIGTERM at deadline → SIGKILL after grace → onForceResolve after escape bound", async () => {
		const target = fakeTarget();
		let forceResolved = 0;
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 30,
			graceMs: 40,
			target,
			onForceResolve: () => {
				forceResolved++;
			},
		});

		// Deadlines: SIGTERM ≈30ms, SIGKILL ≈70ms, force-resolve ≈110ms
		await sleep(180);

		const calls = signalsFired(target);
		assert.deepEqual(calls, ["SIGTERM", "SIGKILL"], "signal order: SIGTERM then SIGKILL");
		assert.equal(forceResolved, 1, "force-resolve fires when 'close' never comes");
		assert.equal(watchdog.timedOut, true, "timedOut flips once the deadline fired");
	});

	it("graceMs=0 → immediate SIGKILL escalation (no grace wait)", async () => {
		const target = fakeTarget();
		armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 0,
			target,
			onForceResolve: () => {},
		});

		// SIGTERM ≈20ms, SIGKILL immediately after, force-resolve immediately after.
		// Margin is generous (80ms) so a loaded parallel runner cannot make the
		// zero-grace escalation miss the assertion window.
		await sleep(80);
		const calls = signalsFired(target);
		assert.deepEqual(calls, ["SIGTERM", "SIGKILL"], "grace 0 skips the wait between signals");
	});

	it("timeoutMs=null → no timers, no kills, no force-resolve (configured 0 = no timeout)", async () => {
		const target = fakeTarget();
		let forceResolved = 0;
		const watchdog = armDeadlineWatchdog({
			timeoutMs: null,
			graceMs: 10,
			target,
			onForceResolve: () => {
				forceResolved++;
			},
		});

		await sleep(60);
		assert.equal(target.killGroup.mock.calls.length, 0, "no kill issued");
		assert.equal(forceResolved, 0, "no force-resolve");
		assert.equal(watchdog.timedOut, false, "timedOut stays false");
	});

	it("dispose() cancels all pending timers — idempotent, no late kills", async () => {
		const target = fakeTarget();
		let forceResolved = 0;
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 20,
			target,
			onForceResolve: () => {
				forceResolved++;
			},
		});

		await sleep(10);
		watchdog.dispose();
		watchdog.dispose(); // idempotent
		await sleep(80);

		assert.equal(target.killGroup.mock.calls.length, 0, "dispose before deadline → no kill");
		assert.equal(forceResolved, 0, "dispose before deadline → no force-resolve");
	});

	it("dispose() after deadline fired still cancels the escalation ladder", async () => {
		const target = fakeTarget();
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 200, // long grace — SIGKILL would be far away
			target,
			onForceResolve: () => {},
		});

		await sleep(30); // SIGTERM fired; SIGKILL is 200ms out
		watchdog.dispose();
		await sleep(60);
		const calls = signalsFired(target);
		assert.deepEqual(calls, ["SIGTERM"], "escalation cancelled — no late SIGKILL");
		assert.equal(watchdog.timedOut, true, "deadline did fire before dispose");
	});

	it("escalationSettled resolves only after SIGKILL — a leader 'close' cannot cancel it (audit #1)", async () => {
		const target = fakeTarget();
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 60,
			target,
			onForceResolve: () => {},
		});

		// SIGTERM fires at ≈20ms; SIGKILL is 60ms out. The escalation promise
		// must NOT settle before SIGKILL, so an awaiter cannot dispose early.
		const settled = watchdog.escalationSettled.then(() => signalsFired(target).slice());
		await sleep(35);
		assert.deepEqual(signalsFired(target), ["SIGTERM"], "SIGKILL not yet issued");
		await settled;
		assert.deepEqual(
			signalsFired(target),
			["SIGTERM", "SIGKILL"],
			"escalation settles only once SIGKILL has been issued",
		);
	});

	it("timeoutMs=null → escalationSettled already resolved (no timers)", async () => {
		const target = fakeTarget();
		const watchdog = armDeadlineWatchdog({
			timeoutMs: null,
			graceMs: 10,
			target,
			onForceResolve: () => {},
		});
		await watchdog.escalationSettled; // must not hang
		assert.equal(target.killGroup.mock.calls.length, 0);
	});

	it("non-ESRCH kill failure is surfaced as killError, not a silent timeout (audit finding #2)", async () => {
		const target = fakeTarget();
		target.killGroup.mock.mockImplementation(() => {
			const err = new Error("operation not permitted") as NodeJS.ErrnoException;
			err.code = "EPERM";
			return err;
		});
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 20,
			target,
			onForceResolve: () => {},
		});

		await sleep(80);
		assert.equal(watchdog.timedOut, true);
		assert.match(
			watchdog.killError ?? "",
			/SIGTERM failed: EPERM/,
			"a failed group kill must be visible to the caller, not silently dropped",
		);
	});

	it("killError is null when every group kill is delivered (no false alarms)", async () => {
		const target = fakeTarget();
		const watchdog = armDeadlineWatchdog({
			timeoutMs: 20,
			graceMs: 20,
			target,
			onForceResolve: () => {},
		});

		await sleep(80);
		assert.equal(watchdog.killError, null);
	});

	it("DEFAULT_KILL_GRACE_MS is 10_000 (agentKillGraceSec default 10s)", () => {
		assert.equal(DEFAULT_KILL_GRACE_MS, 10_000);
	});
});