// Phase 5b — `runValidation` filing policy and resume semantics (fake ports).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CheckpointMismatchError } from "../lib/checkpoint.ts";
import { runValidation } from "../lib/run.ts";
import {
	ALL_GOOD,
	BAD_STEP,
	GOOD_STEP,
	HEAD_SHA,
	PENDING_STEP,
	RUN_FINGERPRINT,
	fixture,
	harness,
	testKeyOf,
} from "./support/run-fakes.mts";
import type { Script } from "./support/run-fakes.mts";
import type { Verdict } from "../lib/types.ts";

describe("run: filing policy", () => {
	it("files exactly one issue listing only the BAD test", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps, reports } = harness(script);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.filer.creates.length, 1);
		assert.equal(deps.checkpoint.appends.filter((entry) => entry === "issue-intent").length, 1);
		assert.equal(deps.checkpoint.appends.at(-1), "issue");
		const [{ title, body }] = deps.filer.creates;
		assert.match(title, /^Test quality review: 1 BAD tests$/);
		assert.match(body, /b-bad/);
		assert.doesNotMatch(body, /a-good/);
		assert.equal(reports.length, 1);
		assert.equal(reports[0].issue?.url, deps.filer.url);
		assert.equal(result.issue?.url, deps.filer.url);
	});

	it("writes no report and files nothing while any test is pending", async () => {
		const script: Script = {
			...ALL_GOOD,
			"suite > b-bad": [BAD_STEP],
			"suite > c-good": [PENDING_STEP, PENDING_STEP, PENDING_STEP],
		};
		const { deps, reports } = harness(script);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(result.complete, false);
		assert.equal(reports.length, 0);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(deps.checkpoint.appends.includes("issue-intent"), false);
	});

	it("writes the report and files nothing when no test is BAD", async () => {
		const { deps, reports } = harness(ALL_GOOD);
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(reports.length, 1);
		assert.equal(reports[0].counts.bad, 0);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(result.issue, null);
	});

	it("reuses a filed issue instead of creating a second one", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps, reports } = harness(script, {
			prior: {
				resumed: true,
				issue: { runFingerprint: RUN_FINGERPRINT, url: "https://example.test/1" },
			},
		});
		const { inventory, sources } = fixture();

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.equal(deps.filer.creates.length, 0);
		assert.equal(deps.filer.searches.length, 0);
		assert.equal(result.issue?.url, "https://example.test/1");
		assert.equal(reports[0].issue?.url, "https://example.test/1");
	});

	it("recovers a filed issue from an intent without creating a duplicate", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps } = harness(script, {
			prior: {
				resumed: true,
				issueIntent: { runFingerprint: RUN_FINGERPRINT, title: "Test quality review: 1 BAD tests" },
			},
		});
		const { inventory, sources } = fixture();
		deps.filer.searchResult = { runFingerprint: RUN_FINGERPRINT, url: "https://example.test/9" };

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.deepEqual(deps.filer.searches, [RUN_FINGERPRINT]);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(result.issue?.url, "https://example.test/9");
		assert.equal(deps.checkpoint.appends.includes("issue"), true);
	});

	it("creates the issue when a resumed search finds nothing", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps } = harness(script, {
			prior: {
				resumed: true,
				issueIntent: { runFingerprint: RUN_FINGERPRINT, title: "Test quality review: 1 BAD tests" },
			},
		});
		const { inventory, sources } = fixture();

		await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.deepEqual(deps.filer.searches, [RUN_FINGERPRINT]);
		assert.equal(deps.filer.creates.length, 1);
	});

	it("halts without creating when the resume search fails", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps, reports } = harness(script, {
			prior: {
				resumed: true,
				issueIntent: { runFingerprint: RUN_FINGERPRINT, title: "Test quality review: 1 BAD tests" },
			},
		});
		const { inventory, sources } = fixture();
		deps.filer.searchThrows = true;

		await assert.rejects(
			() =>
				runValidation(deps, {
					inventory,
					sources,
					runFingerprint: RUN_FINGERPRINT,
					headSha: HEAD_SHA,
				}),
			/gh issue list failed/,
		);
		assert.equal(deps.filer.creates.length, 0);
		assert.equal(reports.length, 0);
	});

	it("halts on a failed create and recovers on the next run", async () => {
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [BAD_STEP] };
		const { deps, reports } = harness(script);
		const { inventory, sources } = fixture();
		deps.filer.createThrows = true;

		await assert.rejects(
			() =>
				runValidation(deps, {
					inventory,
					sources,
					runFingerprint: RUN_FINGERPRINT,
					headSha: HEAD_SHA,
				}),
			/gh issue create failed/,
		);
		assert.equal(deps.checkpoint.appends.includes("issue"), false);
		assert.equal(reports.length, 0);

		// Resumed run: the intent is on disk, so it searches before creating.
		deps.filer.createThrows = false;
		deps.filer.searchResult = { runFingerprint: RUN_FINGERPRINT, url: "https://example.test/7" };
		await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
			restart: false,
		});

		assert.equal(deps.filer.creates.length, 0);
		assert.equal(reports.at(-1)?.issue?.url, "https://example.test/7");
	});
});

describe("run: resume", () => {
	it("only judges tests without a prior decision", async () => {
		const { inventory, sources } = fixture();
		const prior = new Map<string, Verdict>();
		for (const def of inventory.tests.slice(0, 3)) {
			prior.set(testKeyOf(def), {
				decision: "GOOD",
				confidence: 0.9,
				criteria: ["C1"],
				reason: "prior",
				evidence: [],
				pendingReason: "",
			});
		}
		const script: Script = { ...ALL_GOOD, "suite > b-bad": [GOOD_STEP] };
		const { deps } = harness(script, { prior: { resumed: true, verdicts: prior } });

		const result = await runValidation(deps, {
			inventory,
			sources,
			runFingerprint: RUN_FINGERPRINT,
			headSha: HEAD_SHA,
		});

		assert.deepEqual(deps.model.calls.sort(), ["suite > d-good", "suite > e-good"]);
		assert.equal(result.counts.reused, 3);
		assert.equal(result.complete, true);
	});

	it("propagates a refused checkpoint without calling the model", async () => {
		const { deps } = harness(ALL_GOOD);
		const { inventory, sources } = fixture();
		const refusal = new CheckpointMismatchError("inventory", { added: 1, removed: 2, modified: 0 });
		deps.checkpoint.refuse = refusal;

		await assert.rejects(
			() =>
				runValidation(deps, {
					inventory,
					sources,
					runFingerprint: RUN_FINGERPRINT,
					headSha: HEAD_SHA,
				}),
			(err: unknown) => {
				assert.equal(err, refusal);
				assert.equal(refusal.added, 1);
				return true;
			},
		);
		assert.equal(deps.model.calls.length, 0);
		assert.deepEqual(deps.checkpoint.appends, []);
	});
});
