// Phase 4c — a stored BAD verdict is a claim, not a fact.
//
// The checkpoint persists what the judge once said. A record can be well-formed
// and still fail the policy that made it BAD (criterion `C4` alone, confidence
// under the configured threshold, a quote outside the judged lines). Replaying
// such a record would let a resume report a false BAD, so every stored BAD
// verdict is re-checked against the current slice and threshold before a run
// treats it as completed. A refused record is judged again; nothing is deleted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

import { JsonlCheckpointStore } from "../lib/checkpoint.ts";
import { verdictRecord } from "../lib/checkpoint-writers.ts";
import { revalidateStoredVerdicts } from "../lib/checkpoint-verdict-gate.ts";
import { configFingerprint, inventoryFingerprint } from "../lib/fingerprint.ts";
import { runValidation } from "../lib/run.ts";
import {
	FakeFiler,
	FakeModel,
	GOOD_STEP,
	HEAD_SHA,
	RUN_FINGERPRINT,
	config,
} from "./support/run-fakes.mts";
import {
	SOURCE,
	badVerdict,
	def,
	goodVerdict,
	openOptions,
	withTempDir,
} from "./support/checkpoint-fixtures.mts";
import { testKey } from "../lib/types.ts";
import type { TestDefinition, Verdict } from "../lib/types.ts";

const DEFS: TestDefinition[] = [def(), def({ name: "second", startLine: 9, endLine: 11 })];
const CRITERIA_SHA = "5".repeat(64);

/** The fingerprints `runValidation` will compute for DEFS and the test config. */
const SEED = {
	definitions: DEFS,
	inventoryFingerprint: inventoryFingerprint(DEFS),
	configFingerprint: configFingerprint(config(), CRITERIA_SHA),
};
const SOURCES = new Map([["src/a.test.mts", SOURCE]]);
const SECOND_GOOD = goodVerdict({ evidence: [{ line: 10, quote: "assert.ok(true);" }] });

function revalidate(verdicts: Map<string, Verdict>, threshold = 0.8) {
	return revalidateStoredVerdicts({
		verdicts,
		definitions: DEFS,
		sources: SOURCES,
		badConfidenceThreshold: threshold,
	});
}

function one(def_: TestDefinition, verdict: Verdict): Map<string, Verdict> {
	return new Map([[testKey(def_), verdict]]);
}

describe("checkpoint gate: a stored BAD verdict must still satisfy the gate", () => {
	it("replays a BAD verdict whose criterion, confidence, and quote all hold", () => {
		const result = revalidate(one(DEFS[0], badVerdict()));

		assert.equal(result.verdicts.size, 1);
		assert.deepEqual(result.rejected, []);
		assert.equal(result.verdicts.get(testKey(DEFS[0]))?.decision, "BAD");
	});

	it("refuses a BAD verdict carried by a non-qualifying criterion only", () => {
		const result = revalidate(one(DEFS[0], badVerdict({ criteria: ["C4"] })));

		assert.equal(result.verdicts.size, 0);
		assert.equal(result.rejected.length, 1);
		assert.match(result.rejected[0].reason, /BAD-qualifying/);
		assert.equal(result.rejected[0].key, testKey(DEFS[0]));
	});

	it("refuses a BAD verdict below the configured confidence threshold", () => {
		const result = revalidate(one(DEFS[0], badVerdict({ confidence: 0.79 })));

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /confidence/);
	});

	it("replays a BAD verdict exactly at the threshold", () => {
		const result = revalidate(one(DEFS[0], badVerdict({ confidence: 0.8 })));

		assert.equal(result.verdicts.size, 1);
	});

	it("refuses a BAD verdict whose evidence quote is not verbatim in the slice", () => {
		const result = revalidate(
			one(DEFS[0], badVerdict({ evidence: [{ line: 6, quote: " assert.equal(total, 2);" }] })),
		);

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /verbatim/);
	});

	it("refuses a BAD verdict whose evidence line is outside the judged range", () => {
		const result = revalidate(
			one(DEFS[0], badVerdict({ evidence: [{ line: 20, quote: "assert.equal(total, 2);" }] })),
		);

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /verbatim/);
	});

	it("refuses a BAD verdict with no evidence", () => {
		const result = revalidate(one(DEFS[0], badVerdict({ evidence: [] })));

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /evidence/);
	});

	it("refuses a BAD verdict whose source text is unavailable", () => {
		const result = revalidateStoredVerdicts({
			verdicts: one(DEFS[0], badVerdict()),
			definitions: DEFS,
			sources: new Map(),
			badConfidenceThreshold: 0.8,
		});

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /source/);
	});

	it("refuses a verdict for a test the current inventory does not contain", () => {
		const stale = def({ name: "gone", startLine: 40, endLine: 42 });
		const result = revalidate(one(stale, badVerdict()));

		assert.equal(result.verdicts.size, 0);
		assert.match(result.rejected[0].reason, /inventory/);
	});

	it("replays a GOOD verdict untouched, whatever its evidence says", () => {
		const result = revalidate(
			one(DEFS[1], goodVerdict({ evidence: [{ line: 99, quote: "somewhere else" }] })),
		);

		assert.equal(result.verdicts.size, 1);
		assert.deepEqual(result.rejected, []);
	});

	it("keeps the verdicts it accepts and names the ones it refuses", () => {
		const verdicts = new Map([
			[testKey(DEFS[0]), badVerdict({ criteria: ["C7"] })],
			[testKey(DEFS[1]), SECOND_GOOD],
		]);

		const result = revalidate(verdicts);

		assert.deepEqual([...result.verdicts.keys()], [testKey(DEFS[1])]);
		assert.deepEqual(
			result.rejected.map((entry) => entry.key),
			[testKey(DEFS[0])],
		);
	});

	it("does not mutate its input and is deterministic", () => {
		const verdicts = one(DEFS[0], badVerdict({ criteria: ["C5"] }));

		assert.deepEqual(revalidate(verdicts), revalidate(verdicts));
		assert.equal(verdicts.size, 1);
	});
});

describe("checkpoint gate: the store refuses to replay a policy-invalid record", () => {
	it("reports no rejections for a fresh checkpoint", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			await store.close();

			assert.deepEqual(prior.rejected, []);
		});
	});

	it("drops a gate-invalid BAD record from the resumed verdicts", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.close();
			appendFileSync(
				ctx.path,
				`${JSON.stringify(verdictRecord(def(), badVerdict({ criteria: ["C4"] })))}\n`,
				"utf8",
			);

			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			const live = store.verdicts();
			await store.close();

			assert.equal(prior.resumed, true);
			assert.equal(prior.verdicts.size, 0);
			assert.equal(prior.rejected.length, 1);
			assert.match(prior.rejected[0].reason, /BAD-qualifying/);
			assert.equal(live.size, 0);
		});
	});

	it("replays a gate-satisfying BAD record", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), badVerdict());
			await seed.close();

			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			await store.close();

			assert.equal(prior.verdicts.size, 1);
			assert.deepEqual(prior.rejected, []);
			assert.equal(prior.verdicts.get(testKey(def()))?.decision, "BAD");
		});
	});

	it("uses the configured threshold, not the one the record was written under", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), badVerdict({ confidence: 0.85 }));
			await seed.close();

			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx, { badConfidenceThreshold: 0.95 }));
			await store.close();

			assert.equal(prior.verdicts.size, 0);
			assert.match(prior.rejected[0].reason, /badConfidenceThreshold/);
		});
	});

	it("still replays every GOOD record", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), goodVerdict());
			await seed.close();

			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			await store.close();

			assert.equal(prior.verdicts.size, 1);
			assert.deepEqual(prior.rejected, []);
		});
	});
});

describe("checkpoint gate: a resumed run re-judges what the gate refused", () => {
	function deps(
		model: FakeModel,
		checkpoint: JsonlCheckpointStore,
		filer: FakeFiler,
		logs: string[],
	) {
		return {
			model,
			checkpoint,
			filer,
			config: config(),
			criteriaIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
			criteriaSha256: "5".repeat(64),
			writeReport: () => {},
			log: (line: string) => void logs.push(line),
		};
	}

	const options = {
		inventory: { tests: DEFS, excluded: [] },
		sources: SOURCES,
		runFingerprint: RUN_FINGERPRINT,
		headSha: HEAD_SHA,
	};

	it("judges the refused test again and reports the fresh decision", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx, SEED));
			await seed.appendVerdict(DEFS[1], SECOND_GOOD);
			await seed.close();
			appendFileSync(
				ctx.path,
				`${JSON.stringify(
					verdictRecord(
						DEFS[0],
						badVerdict({ criteria: ["C4"], evidence: [{ line: 20, quote: "outside the slice" }] }),
					),
				)}\n`,
				"utf8",
			);

			const store = new JsonlCheckpointStore(ctx.path);
			const model = new FakeModel({ "keeps total": [GOOD_STEP] });
			const filer = new FakeFiler();
			const logs: string[] = [];
			const result = await runValidation(deps(model, store, filer, logs), options);
			await store.close();

			assert.deepEqual(model.calls, ["keeps total"]);
			const judged = result.report?.tests.find((entry) => entry.name === "keeps total");
			assert.equal(judged?.decision, "GOOD");
			assert.equal(result.counts.bad, 0);
			assert.equal(result.issue, null);
			assert.deepEqual(filer.creates, []);
			assert.ok(
				logs.some((line) => /refused 1 stored decision/.test(line)),
				`logs must report the refusal: ${logs.join(" | ")}`,
			);
		});
	});

	it("replays a gate-satisfying BAD record without judging it again", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx, SEED));
			await seed.appendVerdict(DEFS[0], badVerdict());
			await seed.appendVerdict(DEFS[1], SECOND_GOOD);
			await seed.close();

			const store = new JsonlCheckpointStore(ctx.path);
			const model = new FakeModel({});
			const filer = new FakeFiler();
			const logs: string[] = [];
			const result = await runValidation(deps(model, store, filer, logs), options);
			await store.close();

			assert.deepEqual(model.calls, []);
			assert.equal(result.counts.bad, 1);
			assert.equal(result.counts.reused, 2);
			assert.equal(filer.creates.length, 1);
			assert.match(filer.creates[0].body, /keeps total/);
		});
	});

	it("replays GOOD records without a model call", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx, SEED));
			await seed.appendVerdict(DEFS[0], goodVerdict());
			await seed.appendVerdict(DEFS[1], SECOND_GOOD);
			await seed.close();

			const store = new JsonlCheckpointStore(ctx.path);
			const model = new FakeModel({});
			const filer = new FakeFiler();
			const logs: string[] = [];
			const result = await runValidation(deps(model, store, filer, logs), options);
			await store.close();

			assert.deepEqual(model.calls, []);
			assert.equal(result.complete, true);
			assert.equal(result.issue, null);
			assert.deepEqual(filer.creates, []);
		});
	});
});
