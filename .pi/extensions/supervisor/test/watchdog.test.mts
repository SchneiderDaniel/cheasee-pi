// ─── Tests: watchdog.ts — liveness probe timer logic ─────────────

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../lib/watchdog.ts";
import type { WatchdogOptions, WatchdogHandle } from "../lib/watchdog.ts";

// ─── createWatchdog ──────────────────────────────────────────────

describe("createWatchdog", () => {
	let handle: WatchdogHandle;
	let timeoutElapsed: number | null;
	let options: WatchdogOptions;

	afterEach(() => {
		if (handle && handle.isRunning()) {
			handle.stop();
		}
	});

	it("returns a WatchdogHandle with all methods", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		assert.equal(typeof handle.reset, "function");
		assert.equal(typeof handle.start, "function");
		assert.equal(typeof handle.stop, "function");
		assert.equal(typeof handle.getElapsedMs, "function");
		assert.equal(typeof handle.isRunning, "function");
	});

	it("is not running initially", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		assert.equal(handle.isRunning(), false);
	});

	it("reports running after start()", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		assert.equal(handle.isRunning(), true);
		handle.stop();
		assert.equal(handle.isRunning(), false);
	});

	it("returns 0 getElapsedMs before any reset", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		assert.equal(handle.getElapsedMs(), 0);
	});

	it("getElapsedMs returns elapsed time after reset", async () => {
		handle = createWatchdog({ timeoutMs: 5000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		await new Promise((r) => setTimeout(r, 50));
		const elapsed = handle.getElapsedMs();
		assert.ok(elapsed >= 40, `elapsed should be >=40, got ${elapsed}`);
		assert.ok(elapsed < 500, `elapsed should be <500, got ${elapsed}`);
		handle.stop();
	});

	it("reset() resets the timer and prevents timeout", async () => {
		timeoutElapsed = null;
		handle = createWatchdog({
			timeoutMs: 200,
			checkIntervalMs: 50,
			onTimeout: (elapsed) => {
				timeoutElapsed = elapsed;
			},
		});
		handle.start();
		// Reset every 100ms — should prevent timeout
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 100));
			handle.reset();
		}
		assert.equal(timeoutElapsed, null, "reset should prevent timeout");
		handle.stop();
	});

	it("fires onTimeout when no reset occurs within timeoutMs", async () => {
		timeoutElapsed = null;
		handle = createWatchdog({
			timeoutMs: 100,
			checkIntervalMs: 30,
			onTimeout: (elapsed) => {
				timeoutElapsed = elapsed;
			},
		});
		handle.start();
		await new Promise((r) => setTimeout(r, 250));
		assert.ok(timeoutElapsed !== null, "watchdog should have fired");
		assert.ok(timeoutElapsed! >= 100, `elapsed should be >=100, got ${timeoutElapsed}`);
		handle.stop();
	});

	it("does not fire onTimeout multiple times (one-shot)", async () => {
		let fireCount = 0;
		timeoutElapsed = null;
		handle = createWatchdog({
			timeoutMs: 80,
			checkIntervalMs: 30,
			onTimeout: (elapsed) => {
				fireCount++;
				timeoutElapsed = elapsed;
			},
		});
		handle.start();
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(fireCount, 1, "onTimeout should fire only once");
		handle.stop();
	});

	it("reset() after timeout re-arms the watchdog", async () => {
		let fireCount = 0;
		handle = createWatchdog({
			timeoutMs: 80,
			checkIntervalMs: 30,
			onTimeout: () => {
				fireCount++;
			},
		});
		handle.start();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(fireCount, 1, "first timeout should fire");

		// Reset — watchdog should re-arm
		handle.reset();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(fireCount, 2, "second timeout should fire after re-arm");
		handle.stop();
	});

	it("stop() prevents further onTimeout calls", async () => {
		let fireCount = 0;
		handle = createWatchdog({
			timeoutMs: 80,
			checkIntervalMs: 30,
			onTimeout: () => {
				fireCount++;
			},
		});
		handle.start();
		await new Promise((r) => setTimeout(r, 150));
		handle.stop();
		const countAfterStop = fireCount;
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(fireCount, countAfterStop, "no additional fires after stop");
	});

	it("start() while already running is a no-op", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		const firstIntervalId = (handle as any).intervalId;
		handle.start(); // should be no-op
		assert.equal(handle.isRunning(), true);
		handle.stop();
	});

	// ── pause/resume — tool execution gap exclusion ──
	// When tools like web_crawl run for 60s+ with zero SDK events,
	// pause() stops elapsed-time accumulation so the watchdog doesn't
	// fire erroneously. resume() restarts accumulation, subtracting
	// the paused interval.

	it("pause() prevents timeout during paused interval", async () => {
		let fired = false;
		handle = createWatchdog({
			timeoutMs: 100,
			checkIntervalMs: 30,
			onTimeout: () => {
				fired = true;
			},
		});
		handle.start();
		// Immediately pause — should prevent timeout despite wall-clock advancing
		handle.pause();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(fired, false, "watchdog should NOT fire while paused");
		handle.stop();
	});

	it("resume() re-enables timeout from pre-pause elapsed", async () => {
		let fired = false;
		handle = createWatchdog({
			timeoutMs: 150,
			checkIntervalMs: 30,
			onTimeout: () => {
				fired = true;
			},
		});
		handle.start();
		// Let 50ms of event time accumulate
		await new Promise((r) => setTimeout(r, 50));
		handle.pause();
		// Pause for 200ms — this time should NOT count
		await new Promise((r) => setTimeout(r, 200));
		handle.resume();
		// Now we have ~50ms of accumulated time. Need another ~100ms to fire.
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(
			fired,
			true,
			"watchdog should fire after pre-pause elapsed + post-resume accumulates to timeoutMs",
		);
		handle.stop();
	});

	it("pause/resume correctly excludes multiple paused intervals", async () => {
		let fired = false;
		handle = createWatchdog({
			timeoutMs: 200,
			checkIntervalMs: 30,
			onTimeout: () => {
				fired = true;
			},
		});
		handle.start();
		// Phase 1: 60ms active
		await new Promise((r) => setTimeout(r, 60));
		handle.pause();
		await new Promise((r) => setTimeout(r, 150)); // paused — exclude
		handle.resume();
		// Phase 2: 60ms active
		await new Promise((r) => setTimeout(r, 60));
		handle.pause();
		await new Promise((r) => setTimeout(r, 150)); // paused — exclude
		handle.resume();
		// Phase 3: need ~80ms more to reach 200ms total active
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(
			fired,
			true,
			"watchdog should fire after accumulated active time reaches timeoutMs",
		);
		handle.stop();
	});

	it("pause() while already paused is a no-op", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		handle.pause();
		handle.pause(); // no-op
		handle.resume();
		// Should not throw and should still be running
		assert.equal(handle.isRunning(), true);
		handle.stop();
	});

	it("resume() while not paused is a no-op", () => {
		handle = createWatchdog({ timeoutMs: 1000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		handle.resume(); // no-op
		assert.equal(handle.isRunning(), true);
		handle.stop();
	});

	it("getElapsedMs excludes paused time", async () => {
		handle = createWatchdog({ timeoutMs: 5000, checkIntervalMs: 100, onTimeout: () => {} });
		handle.start();
		await new Promise((r) => setTimeout(r, 50));
		handle.pause();
		await new Promise((r) => setTimeout(r, 200));
		const pausedElapsed = handle.getElapsedMs();
		// During pause, elapsed should not advance
		assert.ok(
			pausedElapsed < 100,
			`paused elapsed should be <100ms (only pre-pause time), got ${pausedElapsed}`,
		);
		handle.resume();
		await new Promise((r) => setTimeout(r, 50));
		const resumedElapsed = handle.getElapsedMs();
		assert.ok(
			resumedElapsed >= 90,
			`after resume elapsed should accumulate, got ${resumedElapsed}`,
		);
		handle.stop();
	});

	it("reset() clears accumulated paused time", async () => {
		let fired = false;
		handle = createWatchdog({
			timeoutMs: 150,
			checkIntervalMs: 30,
			onTimeout: () => {
				fired = true;
			},
		});
		handle.start();
		await new Promise((r) => setTimeout(r, 50));
		handle.pause();
		await new Promise((r) => setTimeout(r, 200));
		handle.reset(); // clear everything, including paused accumulator
		handle.resume();
		// After reset, need full timeoutMs from now
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(fired, false, "reset should clear accumulated time, watchdog not yet fired");
		// Wait enough for check interval to fire: 150ms timeout + 2 check cycles margin
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(fired, true, "watchdog should fire timeoutMs after reset");
		handle.stop();
	});
});
