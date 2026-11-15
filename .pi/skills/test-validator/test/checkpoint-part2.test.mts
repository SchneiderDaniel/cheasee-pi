// Phase 4b — checkpoint resume guard, restart archiving, and the single-writer
// lock. Real filesystem, temp directories.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";

import {
	CheckpointLockError,
	CheckpointMismatchError,
	JsonlCheckpointStore,
	readCheckpointRecords,
} from "../lib/checkpoint.ts";
import { inventoryFingerprint } from "../lib/fingerprint.ts";
import { testKey } from "../lib/types.ts";
import {
	CONFIG_HASH,
	CRITERIA_HASH,
	badVerdict,
	def,
	goodVerdict,
	openOptions,
	readLines,
	withTempDir,
} from "./support/checkpoint-fixtures.mts";

describe("checkpoint: resume guard, restart, and locking", () => {
	it("resumes when the fingerprints still match", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.resumed, true);
			assert.equal(prior.verdicts.size, 1);
		});
	});

	it("replays a stored BAD that still passes the gate", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), badVerdict());
			await seed.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.verdicts.size, 1);
			assert.deepEqual(prior.rejected, []);
		});
	});

	it("refuses a stored BAD whose criteria do not qualify, instead of replaying it", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			// Structurally valid record, policy-invalid verdict: C4 never justifies a BAD.
			await seed.appendVerdict(def(), badVerdict({ criteria: ["C4"] }));
			await seed.close();
			const before = readFileSync(ctx.path, "utf8");

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.verdicts.size, 0, "a gate-refused BAD must not count as decided");
			assert.equal(prior.rejected.length, 1);
			assert.equal(prior.rejected[0].key, testKey(def()));
			assert.match(prior.rejected[0].reason, /BAD-qualifying/);
			assert.equal(readFileSync(ctx.path, "utf8"), before, "refusal must not delete the record");
		});
	});

	it("refuses a stored BAD whose evidence is outside the judged slice", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(
				def(),
				badVerdict({ evidence: [{ line: 99, quote: "assert.equal(total, 2);" }] }),
			);
			await seed.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.verdicts.size, 0);
			assert.equal(prior.rejected.length, 1);
			assert.match(prior.rejected[0].reason, /verbatim/);
		});
	});

	it("refuses a stored BAD judged below the configured threshold", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			// Valid under the seeding threshold of 0.8, refused under a stricter 0.95.
			await seed.appendVerdict(def(), badVerdict({ confidence: 0.9 }));
			await seed.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx, { badConfidenceThreshold: 0.95 }));
			await reopened.close();

			assert.equal(prior.verdicts.size, 0);
			assert.equal(prior.rejected.length, 1);
			assert.match(prior.rejected[0].reason, /confidence/);
		});
	});

	it("refuses a changed inventory and reports added/removed/modified counts", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), goodVerdict());
			await seed.appendVerdict(def({ name: "gone", startLine: 20, endLine: 22 }), goodVerdict());
			await seed.appendVerdict(def({ name: "edited", startLine: 30, endLine: 33 }), goodVerdict());
			await seed.close();

			const current = [
				def(),
				def({ name: "added", startLine: 40, endLine: 42 }),
				def({ name: "edited", startLine: 30, endLine: 33, sourceSha256: "e".repeat(64) }),
			];

			const reopened = new JsonlCheckpointStore();
			await assert.rejects(
				() =>
					reopened.open(
						openOptions(ctx, {
							definitions: current,
							inventoryFingerprint: inventoryFingerprint(current),
						}),
					),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointMismatchError);
					assert.equal(err.kind, "inventory");
					assert.equal(err.added, 1);
					assert.equal(err.removed, 1);
					assert.equal(err.modified, 1);
					assert.match(err.message, /--restart/);
					return true;
				},
			);
		});
	});

	it("refuses a changed model configuration", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), goodVerdict());
			await seed.close();

			const reopened = new JsonlCheckpointStore();
			await assert.rejects(
				() => reopened.open(openOptions(ctx, { configFingerprint: "9".repeat(64) })),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointMismatchError);
					assert.equal(err.kind, "config");
					assert.match(err.message, /--restart/);
					return true;
				},
			);
		});
	});

	it("archives an existing checkpoint on --restart without deleting it", async () => {
		await withTempDir(async (ctx) => {
			const seed = new JsonlCheckpointStore();
			await seed.open(openOptions(ctx));
			await seed.appendVerdict(def(), goodVerdict());
			await seed.close();
			const previous = readFileSync(ctx.path, "utf8");

			const restarted = new JsonlCheckpointStore();
			const prior = await restarted.open(openOptions(ctx, { restart: true }));
			await restarted.close();

			assert.ok(prior.archivePath);
			assert.ok(prior.archivePath.endsWith(".jsonl"));
			assert.match(prior.archivePath, /archive/);
			assert.equal(existsSync(prior.archivePath), true);
			assert.equal(readFileSync(prior.archivePath, "utf8"), previous);

			const records = readLines(ctx.path);
			assert.equal(records.length, 1);
			assert.equal((records[0] as Record<string, unknown>).type, "header");
			assert.equal(prior.verdicts.size, 0);
		});
	});

	it("admits a single writer per path", async () => {
		await withTempDir(async (ctx) => {
			const first = new JsonlCheckpointStore();
			await first.open(openOptions(ctx));
			const before = readFileSync(ctx.path, "utf8");

			const second = new JsonlCheckpointStore();
			await assert.rejects(
				() => second.open(openOptions(ctx)),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointLockError);
					assert.match(err.message, /lock/i);
					return true;
				},
			);
			assert.equal(readFileSync(ctx.path, "utf8"), before);

			await first.close();
		});
	});

	it("releases the lock when an append throws", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			const content = readFileSync(ctx.path, "utf8");

			// Replace the checkpoint with a directory: appendFileSync now fails with
			// EISDIR, which is the "append threw" path that must release the lock.
			rmSync(ctx.path);
			mkdirSync(ctx.path);
			await assert.rejects(() => store.appendVerdict(def(), goodVerdict()), /append failed/);

			rmSync(ctx.path, { recursive: true });
			writeFileSync(ctx.path, content, "utf8");

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();
			assert.equal(prior.resumed, true);
		});
	});

	it("keeps the checkpoint free of `undefined` fields", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.appendPending(def({ name: "later", startLine: 12, endLine: 14 }), {
				attempts: 2,
				pendingReason: "schema: reason is missing",
			});
			await store.recordIssueIntent({ runFingerprint: "f".repeat(64), title: "t" });
			await store.recordIssue({ runFingerprint: "f".repeat(64), url: "https://example.test/1" });
			await store.close();

			const raw = readFileSync(ctx.path, "utf8");
			assert.equal(raw.includes("undefined"), false);
			for (const record of readCheckpointRecords(ctx.path)) {
				assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
			}

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx, { definitions: [def()] }));
			await reopened.close();
			assert.equal(prior.issue?.url, "https://example.test/1");
			assert.equal(prior.issueIntent?.runFingerprint, "f".repeat(64));
		});
	});

	it("treats an all-blank file as fresh", async () => {
		await withTempDir(async (ctx) => {
			writeFileSync(ctx.path, "", "utf8");
			truncateSync(ctx.path, 0);

			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			await store.close();

			assert.equal(prior.resumed, false);
			assert.equal(readLines(ctx.path).length, 1);
		});
	});
});
