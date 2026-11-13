/**
 * Tests for session-logger record fixtures de-duplication (issue #2105).
 *
 * `test/helpers/record-fixtures.ts` is the single owner of `extractText`,
 * `userMessageToRecord`, `LogRecord` and `TokenUsage`. The three
 * `session-logger*.test.mts` suites import them instead of re-declaring
 * byte-identical local copies.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-dedup.test.mts
 */

import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { extractText, userMessageToRecord, type LogRecord } from "./helpers/record-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── extractText ────────────────────────────────────────────────────────────

describe("extractText", () => {
	it("plain string passes through", () => {
		assert.strictEqual(extractText("plain"), "plain");
	});

	it("undefined, null and non-array non-string → empty string", () => {
		assert.strictEqual(extractText(undefined), "");
		assert.strictEqual(extractText(null), "");
		assert.strictEqual(extractText({}), "");
	});

	it("joins text blocks with a blank line and drops non-text blocks", () => {
		const blocks = [
			{ type: "text", text: "a" },
			{ type: "toolCall", name: "x" },
			{ type: "text", text: "b" },
		];
		assert.strictEqual(extractText(blocks), "a\n\nb");
	});
});

// ─── userMessageToRecord ────────────────────────────────────────────────────

describe("userMessageToRecord", () => {
	it("maps a user message to a LogRecord", () => {
		const record = userMessageToRecord(
			{
				timestamp: "2024-01-01T00:00:00.000Z",
				content: [{ type: "text", text: "hi" }],
			},
			3,
		);
		assert.deepStrictEqual(record, {
			timestamp: "2024-01-01T00:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 3,
			payload: { role: "user", content: "hi" },
		});
	});

	it("converts a numeric timestamp to ISO", () => {
		const record = userMessageToRecord({ timestamp: 0, content: [] }, 0);
		assert.strictEqual(record.timestamp, "1970-01-01T00:00:00.000Z");
	});

	it("missing content → empty payload content", () => {
		const record = userMessageToRecord({ timestamp: 0 }, 1);
		assert.strictEqual(record.payload.content, "");
	});

	it("never carries token_usage and always records error: null", () => {
		const record: LogRecord = userMessageToRecord(
			{ timestamp: 0, content: "text", usage: { input: 1, output: 2, total: 3 } },
			2,
		);
		assert.strictEqual(record.token_usage, undefined);
		assert.ok(!("token_usage" in record), "user records must not carry token_usage");
		assert.strictEqual(record.error, null);
	});
});

// ─── Guards: one owner, no local copies in the test layer ───────────────────

describe("session-logger record fixture dedup guards", () => {
	// The guard file itself quotes these declaration strings, so it is not scanned.
	const self = fileURLToPath(import.meta.url);
	const testFiles = readdirSync(here, { recursive: true, encoding: "utf-8" })
		.filter((name) => name.endsWith(".test.mts"))
		.map((name) => join(here, name))
		.filter((file) => file !== self);

	const readSource = (file: string): string => readFileSync(file, "utf-8");
	const countOccurrences = (source: string, needle: string): number =>
		source.split(needle).length - 1;

	it("scans the recursive test tree (guard would silently pass on an empty list)", () => {
		assert.ok(
			testFiles.length >= 30,
			`expected the session-logger test tree, got ${testFiles.length}`,
		);
	});

	for (const declaration of ["function userMessageToRecord", "function extractText"]) {
		it(`no *.test.mts under session-logger/test declares ${declaration}`, () => {
			const offenders = testFiles.filter((file) => readSource(file).includes(declaration));
			assert.deepStrictEqual(offenders, [], `duplicate declaration in: ${offenders.join(", ")}`);
		});
	}

	for (const file of ["session-logger.test.mts", "session-logger-part3.test.mts"]) {
		it(`${file} imports userMessageToRecord from ./helpers/record-fixtures.ts`, () => {
			const source = readSource(join(here, file));
			assert.ok(
				/import\s*\{[^}]*\buserMessageToRecord\b[^}]*\}\s*from\s*"\.\/helpers\/record-fixtures\.ts"/.test(
					source,
				),
				`${file} must import userMessageToRecord from the helper`,
			);
		});
	}

	it("session-logger-part2.test.mts never used it — no dead import introduced", () => {
		const source = readSource(join(here, "session-logger-part2.test.mts"));
		assert.strictEqual(countOccurrences(source, "userMessageToRecord"), 0);
	});
});
