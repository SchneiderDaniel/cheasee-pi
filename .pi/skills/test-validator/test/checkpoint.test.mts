// Phase 4a — the JSONL checkpoint adapter: header, appended records, torn-tail
// recovery, and corruption that must halt. Real filesystem, temp directories.
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
import {
	CONFIG_HASH,
	CRITERIA_HASH,
	INVENTORY_HASH,
	def,
	goodVerdict,
	openOptions,
	readLines,
	withTempDir,
} from "./support/checkpoint-fixtures.mts";

describe("checkpoint: append-only JSONL store", () => {
	it("writes only a header line on a fresh path", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			const prior = await store.open(openOptions(ctx));
			await store.close();

			assert.equal(prior.resumed, false);
			assert.equal(prior.archivePath, null);
			assert.equal(prior.verdicts.size, 0);

			const records = readLines(ctx.path);
			assert.equal(records.length, 1);
			const [header] = records as Record<string, unknown>[];
			assert.equal(header.type, "header");
			assert.equal(header.inventoryFingerprint, INVENTORY_HASH);
			assert.equal(header.configFingerprint, CONFIG_HASH);
			assert.equal(header.criteriaSha256, CRITERIA_HASH);
			assert.equal(typeof header.schemaVersion, "number");
		});
	});

	it("returns an appended verdict keyed by file, range, and name", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.resumed, true);
			const verdict = prior.verdicts.get("src/a.test.mts:5-8:keeps total");
			assert.ok(verdict);
			assert.equal(verdict.decision, "GOOD");
			assert.deepEqual(verdict.criteria, ["C2"]);
		});
	});

	it("lets the latest record for a test win", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendPending(def(), { attempts: 1, pendingReason: "ambiguous" });
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx));
			await reopened.close();

			assert.equal(prior.verdicts.get("src/a.test.mts:5-8:keeps total")?.decision, "GOOD");
			assert.equal(prior.attempts.get("src/a.test.mts:5-8:keeps total"), 1);
		});
	});

	it("discards a torn trailing line and keeps the completed records", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const before = readFileSync(ctx.path, "utf8");
			writeFileSync(ctx.path, `${before}{"type":"verdict","file":"src/a.tes`, "utf8");

			const records = readCheckpointRecords(ctx.path);
			assert.equal(records.length, 2);
			assert.equal(records[1].type, "verdict");

			const other = def({ name: "other", startLine: 20, endLine: 22 });
			const reopened = new JsonlCheckpointStore();
			const prior = await reopened.open(openOptions(ctx, { definitions: [def(), other] }));
			await reopened.close();

			assert.equal(prior.verdicts.has("src/a.test.mts:20-22:other"), false);
			assert.equal(prior.verdicts.get("src/a.test.mts:5-8:keeps total")?.decision, "GOOD");
		});
	});

	it("halts on corruption in a completed middle line", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const lines = readFileSync(ctx.path, "utf8").split("\n");
			lines.splice(1, 0, "not json at all");
			writeFileSync(ctx.path, lines.join("\n"), "utf8");

			assert.throws(() => readCheckpointRecords(ctx.path), /corrupt/i);
		});
	});
});
