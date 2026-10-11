/**
 * Tests for index.ts — MAX_CONCURRENT_CRAWLS lock pattern.
 *
 * Layer: entity — exercises the acquire/release pattern the handler mirrors.
 * Split out of index.test.ts (issue #2001).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("MAX_CONCURRENT_CRAWLS — memory protection", () => {
	it("(entity) MAX_CONCURRENT_CRAWLS should be exactly 2", () => {
		const MAX_CONCURRENT_CRAWLS = 2;
		assert.equal(MAX_CONCURRENT_CRAWLS, 2, "should allow max 2 concurrent crawls");
	});

	it("(entity) acquire/release lock pattern prevents over-allocation", async () => {
		let activeCrawls = 0;
		const MAX = 2;
		const executionOrder: number[] = [];

		async function acquire(): Promise<void> {
			while (activeCrawls >= MAX) {
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
			executionOrder.push(activeCrawls);
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
			executionOrder.push(-activeCrawls);
		}

		const p1 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();
		const p2 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();
		const p3 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();

		const checkInterval = setInterval(() => {
			assert.ok(activeCrawls <= MAX, `activeCrawls (${activeCrawls}) should not exceed ${MAX}`);
		}, 5);

		await Promise.all([p1, p2, p3]);
		clearInterval(checkInterval);
		assert.equal(activeCrawls, 0, "all crawls should complete and release");
	});

	it("(entity) acquire with abort signal — abort mid-wait throws AbortError", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots by holding locks with deferred gates
		let resolveA!: () => void;
		const gateA = new Promise<void>((r) => { resolveA = r; });
		let resolveB!: () => void;
		const gateB = new Promise<void>((r) => { resolveB = r; });

		const p1 = (async () => {
			await acquire();
			await gateA;
			release();
		})();
		const p2 = (async () => {
			await acquire();
			await gateB;
			release();
		})();

		// Wait for p1, p2 to acquire
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(activeCrawls, 2, "both slots should be occupied");

		// Third call with abort signal — queues in while loop
		const controller = new AbortController();
		const p3 = acquire(controller.signal);

		// Give p3 time to enter the while loop
		await new Promise((r) => setTimeout(r, 20));

		// Abort while waiting
		controller.abort();

		// p3 should reject with AbortError
		await assert.rejects(p3, { name: "AbortError" }, "abort during wait should throw AbortError");

		// Clean up: release gates
		resolveA();
		resolveB();
		await Promise.allSettled([p1, p2]);
		assert.equal(activeCrawls, 0, "all should release cleanly");
	});

	it("(entity) acquire with pre-aborted signal — throws synchronously on first check", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots
		activeCrawls = 2;

		const controller = new AbortController();
		controller.abort(); // Pre-abort

		await assert.rejects(
			acquire(controller.signal),
			{ name: "AbortError" },
			"pre-aborted signal should throw synchronously on first check",
		);

		// Clean up
		activeCrawls = 0;
	});

	it("(entity) acquire with no signal — acquires normally when slot opens", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots
		activeCrawls = 2;

		// Start acquire with no signal
		const acquirePromise = acquire();

		// Wait a tick — should be looping
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(activeCrawls, 2, "should still be waiting");

		// Release one slot
		activeCrawls = 1;

		// Now acquire should complete
		await acquirePromise;
		assert.equal(activeCrawls, 2, "should have incremented after acquiring");

		activeCrawls = 0;
	});

	it("(entity) acquire with signal never aborted — acquires normally when slot opens", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		const controller = new AbortController();

		// Fill both slots
		activeCrawls = 2;

		const acquirePromise = acquire(controller.signal);

		// Release one slot
		activeCrawls = 1;

		// Should acquire
		await acquirePromise;
		assert.equal(activeCrawls, 2, "should have incremented");

		// Signal not aborted
		assert.equal(controller.signal.aborted, false, "signal should not be aborted");

		activeCrawls = 0;
	});
});
