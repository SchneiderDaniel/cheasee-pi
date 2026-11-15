// Phase 4c — the checkpoint reader must validate what it reads.
//
// A checkpoint is the audit's memory, so a record that parses as JSON but does
// not describe a real decision must never be replayed as one. Every field is
// checked before a record is admitted; a malformed record halts the run instead
// of turning into a completed report.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { parseCheckpointRecord } from "../lib/checkpoint-schema.ts";
import {
	CHECKPOINT_SCHEMA_VERSION,
	CheckpointError,
	CheckpointSchemaError,
	JsonlCheckpointStore,
	readCheckpointRecords,
} from "../lib/checkpoint.ts";
import { inventoryFingerprint } from "../lib/fingerprint.ts";
import { def, goodVerdict, openOptions, withTempDir } from "./support/checkpoint-fixtures.mts";

const SHA = (char: string): string => char.repeat(64);

const HEADER = {
	type: "header",
	schemaVersion: CHECKPOINT_SCHEMA_VERSION,
	inventoryFingerprint: SHA("a"),
	configFingerprint: SHA("b"),
	criteriaSha256: SHA("c"),
	createdAt: "2026-01-01T00:00:00.000Z",
};

function verdictRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "verdict",
		file: "src/a.test.mts",
		name: "keeps total",
		language: "typescript",
		startLine: 5,
		endLine: 8,
		sourceSha256: SHA("d"),
		decision: "GOOD",
		confidence: 0.91,
		criteria: ["C2"],
		reason: "asserts observable behaviour",
		evidence: [{ line: 6, quote: "assert.equal(total, 2);" }],
		recordedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function pendingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "pending",
		file: "src/a.test.mts",
		name: "keeps total",
		language: "typescript",
		startLine: 5,
		endLine: 8,
		sourceSha256: SHA("d"),
		attempts: 2,
		pendingReason: "ambiguous",
		recordedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function refuses(value: unknown, pattern: RegExp): void {
	assert.throws(
		() => parseCheckpointRecord(value, "checkpoint.jsonl:2"),
		(err: unknown) => {
			assert.ok(err instanceof CheckpointSchemaError, "must be a schema error");
			assert.ok(err instanceof CheckpointError, "must stay a checkpoint error");
			assert.match(err.message, /checkpoint\.jsonl:2/, "the location must be named");
			assert.match(err.message, pattern);
			return true;
		},
	);
}

describe("checkpoint-schema: valid records are admitted", () => {
	it("accepts a header carrying the current schema version", () => {
		const record = parseCheckpointRecord(HEADER, "checkpoint.jsonl:1");

		assert.equal(record.type, "header");
		assert.equal(record.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
	});

	it("accepts a GOOD and a BAD verdict record", () => {
		assert.equal(parseCheckpointRecord(verdictRecord(), "ck:2").type, "verdict");
		assert.equal(parseCheckpointRecord(verdictRecord({ decision: "BAD" }), "ck:3").type, "verdict");
	});

	it("accepts pending, issue-intent, and issue records", () => {
		assert.equal(parseCheckpointRecord(pendingRecord(), "ck:4").type, "pending");
		assert.equal(
			parseCheckpointRecord(
				{ type: "issue-intent", runFingerprint: SHA("e"), title: "t", recordedAt: "t" },
				"ck:5",
			).type,
			"issue-intent",
		);
		assert.equal(
			parseCheckpointRecord(
				{
					type: "issue",
					runFingerprint: SHA("e"),
					url: "https://example.test/1",
					recordedAt: "t",
				},
				"ck:6",
			).type,
			"issue",
		);
	});

	it("accepts a line number outside the recorded range", () => {
		// A GOOD verdict may cite a line the slice does not contain; the BAD gate
		// is what demands an in-range quote, not the checkpoint schema.
		const record = parseCheckpointRecord(
			verdictRecord({ evidence: [{ line: 8, quote: "});" }] }),
			"ck:7",
		);
		assert.equal(record.type, "verdict");
		assert.equal(
			parseCheckpointRecord(verdictRecord({ evidence: [{ line: 99, quote: "x" }] }), "ck:8").type,
			"verdict",
		);
	});
});

describe("checkpoint-schema: replay never trusts a malformed record", () => {
	it("refuses a verdict whose decision is not GOOD or BAD", () => {
		refuses(verdictRecord({ decision: "BOGUS" }), /decision/i);
		refuses(verdictRecord({ decision: "PENDING" }), /decision/i);
		refuses(verdictRecord({ decision: 42 }), /decision/i);
	});

	it("refuses an unknown record type", () => {
		refuses({ ...verdictRecord(), type: "verdicts" }, /unknown record type/i);
		refuses({ type: 7 }, /unknown record type|type/i);
	});

	it("refuses a record that is not a JSON object", () => {
		refuses(null, /not an object/i);
		refuses([verdictRecord()], /not an object/i);
		refuses("verdict", /not an object/i);
	});

	it("refuses a header from another schema version", () => {
		refuses({ ...HEADER, schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 }, /schema version/i);
		refuses({ ...HEADER, schemaVersion: "1" }, /schema version/i);
	});

	it("refuses a header with a malformed fingerprint", () => {
		refuses({ ...HEADER, inventoryFingerprint: "not-a-hash" }, /inventoryFingerprint/);
		refuses({ ...HEADER, configFingerprint: undefined }, /configFingerprint/);
		refuses({ ...HEADER, criteriaSha256: "ABC" }, /criteriaSha256/);
	});

	it("refuses a verdict with a broken identity", () => {
		refuses(verdictRecord({ file: "" }), /file/);
		refuses(verdictRecord({ name: undefined }), /name/);
		refuses(verdictRecord({ language: "cobol" }), /language/i);
		refuses(verdictRecord({ sourceSha256: "d" }), /sourceSha256/);
		refuses(verdictRecord({ startLine: 0 }), /startLine/);
		refuses(verdictRecord({ startLine: 6, endLine: 5 }), /endLine/);
		refuses(verdictRecord({ endLine: 8.5 }), /endLine/);
	});

	it("refuses a verdict with a broken decision payload", () => {
		refuses(verdictRecord({ confidence: 1.4 }), /confidence/);
		refuses(verdictRecord({ confidence: "high" }), /confidence/);
		refuses(verdictRecord({ reason: "" }), /reason/);
		refuses(verdictRecord({ criteria: ["C9"] }), /criteria/i);
		refuses(verdictRecord({ criteria: "C1" }), /criteria/i);
		refuses(verdictRecord({ evidence: "quote" }), /evidence/i);
		refuses(verdictRecord({ evidence: [{ line: 6 }] }), /evidence/i);
		refuses(verdictRecord({ evidence: [{ line: 6, quote: "" }] }), /evidence/i);
		refuses(verdictRecord({ evidence: [{ line: 0, quote: "outside" }] }), /evidence/i);
		refuses(verdictRecord({ evidence: [{ line: "6", quote: "outside" }] }), /evidence/i);
	});

	it("refuses a pending record with a broken attempt count", () => {
		refuses(pendingRecord({ attempts: -1 }), /attempts/);
		refuses(pendingRecord({ attempts: 1.5 }), /attempts/);
		refuses(pendingRecord({ pendingReason: undefined }), /pendingReason/);
	});

	it("refuses issue records that could not identify an issue", () => {
		refuses({ type: "issue", runFingerprint: SHA("e"), url: "", recordedAt: "t" }, /url/);
		refuses({ type: "issue", runFingerprint: "nope", url: "u", recordedAt: "t" }, /runFingerprint/);
		refuses(
			{ type: "issue-intent", runFingerprint: SHA("e"), title: "", recordedAt: "t" },
			/title/,
		);
	});

	it("refuses a record without a timestamp", () => {
		refuses(verdictRecord({ recordedAt: undefined }), /recordedAt/);
		refuses(pendingRecord({ recordedAt: "" }), /recordedAt/);
	});
});

describe("checkpoint-schema: the reader validates the file it reads", () => {
	it("halts on a tampered verdict instead of replaying it", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const lines = readFileSync(ctx.path, "utf8").split("\n");
			const tampered = { ...JSON.parse(lines[1]), decision: "BOGUS" };
			lines[1] = JSON.stringify(tampered);
			writeFileSync(ctx.path, lines.join("\n"), "utf8");

			assert.throws(
				() => readCheckpointRecords(ctx.path),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointSchemaError);
					assert.match(err.message, /:2/);
					assert.match(err.message, /decision/i);
					return true;
				},
			);
		});
	});

	it("refuses to resume a checkpoint whose header is missing", async () => {
		await withTempDir(async (ctx) => {
			writeFileSync(ctx.path, `${JSON.stringify(verdictRecord())}\n`, "utf8");

			const store = new JsonlCheckpointStore();
			await assert.rejects(
				() => store.open(openOptions(ctx, { definitions: [def()] })),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointError);
					assert.match(err.message, /header/i);
					return true;
				},
			);
		});
	});

	it("refuses to resume a checkpoint written by another schema version", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const lines = readFileSync(ctx.path, "utf8").split("\n");
			lines[0] = JSON.stringify({
				...JSON.parse(lines[0]),
				schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1,
			});
			writeFileSync(ctx.path, lines.join("\n"), "utf8");

			const reopened = new JsonlCheckpointStore();
			await assert.rejects(
				() => reopened.open(openOptions(ctx, { definitions: [def()] })),
				(err: unknown) => {
					assert.ok(err instanceof CheckpointSchemaError);
					assert.match(err.message, /schema version/i);
					return true;
				},
			);
		});
	});

	it("keeps the fingerprint of the definitions it records", async () => {
		await withTempDir(async (ctx) => {
			const store = new JsonlCheckpointStore();
			await store.open(openOptions(ctx));
			await store.appendVerdict(def(), goodVerdict());
			await store.close();

			const [header] = readCheckpointRecords(ctx.path);
			assert.equal(header.type, "header");
			assert.equal(
				(header as { inventoryFingerprint: string }).inventoryFingerprint,
				inventoryFingerprint([def()]),
			);
		});
	});
});
