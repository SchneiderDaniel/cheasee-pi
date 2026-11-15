// Phase 5a — `runValidation`: worker pool, retries, and the circuit breaker.
// The BAD gate, completion gate, and filing policy are covered in part 2.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RunHaltedError, runValidation } from "../lib/run.ts";
import {
	ALL_GOOD,
	BAD_STEP,
	GOOD_STEP,
	HEAD_SHA,
	PENDING_STEP,
	RUN_FINGERPRINT,
	fixture,
	harness,
	throwing,
} from "./support/run-fakes.mts";
import type { Script } from "./support/run-fakes.mts";

describe("run: completion, retries, and the circuit breaker", () => {
	it("judges every test, appends once each, and writes the report once", async () => {
		const { deps } = harness(ALL_GOOD);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(result.complete, true);
		assert.equal(deps.model.calls.length, 5);
		assert.equal(deps.checkpoint.appends.filter((entry) => entry === "verdict").length, 5);
		assert.deepEqual(deps.checkpoint.appends, [
			"header",
			"verdict",
			"verdict",
			"verdict",
			"verdict",
			"verdict",
		]);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(result.report?.issue, null);
	});

	it("never exceeds the configured concurrency", async () => {
		const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
		const { deps } = harness(ALL_GOOD, { cfg: { concurrency: 2 }, gate });
		const { inventory, sources } = fixture();

		await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.model.maxInFlight, 2);
		assert.equal(deps.checkpoint.appends.filter((entry) => entry === "verdict").length, 5);
	});

	it("retries a pending answer until it is decided", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [PENDING_STEP, PENDING_STEP, BAD_STEP] };
		const { deps } = harness(script);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.model.calls.filter((name) => name === "suite > b-bad").length, 3);
		assert.equal(result.counts.bad, 1);
		assert.equal(result.complete, true);
	});

	it("reports an incomplete run when a test never leaves pending", async () => {
		const script: Script = {
			...ALL_GOOD,
			"suite > b-bad": [PENDING_STEP, PENDING_STEP, PENDING_STEP],
		};
		const { deps } = harness(script);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(result.complete, false);
		assert.equal(result.counts.pending, 1);
		assert.equal(result.report, null);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(deps.checkpoint.appends.includes("issue-intent"), false);
	});

	it("recovers from a throwing attempt without tripping the breaker", async () => {
		const script: Script = {
			...ALL_GOOD,
			"suite > b-bad": [throwing("transient provider error"), GOOD_STEP],
		};
		const { deps } = harness(script, { cfg: { haltAfterConsecutiveFailures: 2 } });
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.model.calls.filter((name) => name === "suite > b-bad").length, 2);
		assert.equal(result.complete, true);
	});

	it("halts after N consecutive failures and names the cause", async () => {
		const failing = throwing("provider authentication failed");
		const script: Script = {
			"suite > a-good": [failing],
			"suite > b-bad": [failing],
			"suite > c-good": [failing],
			"suite > d-good": [failing],
			"suite > e-good": [failing],
		};
		const { deps } = harness(script, {
			cfg: { concurrency: 1, haltAfterConsecutiveFailures: 2, maxAttempts: 3 },
		});
		const { inventory, sources } = fixture();

		await assert.rejects(
			() =>
				runValidation(deps, {
					inventory,
					sources,
					runFingerprint: RUN_FINGERPRINT,
					headSha: HEAD_SHA,
				}),
			(err: unknown) => {
				assert.ok(err instanceof RunHaltedError);
				assert.match(err.message, /provider authentication failed/);
				return true;
			},
		);
		assert.equal(deps.model.calls.length, 2);
		assert.equal(deps.filer.creates.length, 0);
	});

	it("resets the failure streak after a success", async () => {
		const failing = throwing("flaky");
		const script: Script = {
			"suite > a-good": [failing],
			"suite > b-bad": [GOOD_STEP],
			"suite > c-good": [failing],
			"suite > d-good": [GOOD_STEP],
			"suite > e-good": [GOOD_STEP],
		};
		const { deps } = harness(script, {
			cfg: { concurrency: 1, haltAfterConsecutiveFailures: 2, maxAttempts: 1 },
		});
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.model.calls.length, 5);
		assert.equal(result.complete, false);
		assert.equal(result.counts.pending, 2);
	});
});
