/**
 * Entity tests: last-json-scanner.ts (extracted from output.ts in #1535).
 *
 * The scanner is the last-JSON extraction + two-pass sanitization safety
 * net for agent output. Behavior is preserved verbatim from the pre-split
 * output.ts; the full regression surface lives in agent-output.test.mts
 * (exercises the same code through the parseAgentOutput facade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractLastJson,
	sanitizeJsonStrings,
	sanitizeJsonStringsConservative,
	THINKING_PREFIX_RE,
} from "../agent/last-json-scanner.ts";

describe("extractLastJson — code fences", () => {
	it("extracts exact JSON substring from prose + ```json fence", () => {
		const raw = [
			"Here is my analysis:",
			"```json",
			'{"action":"COMPLETE","agentName":"architect","commentBody":"Design"}',
			"```",
			"The end.",
		].join("\n");
		assert.equal(
			extractLastJson(raw),
			'{"action":"COMPLETE","agentName":"architect","commentBody":"Design"}',
		);
	});

	it("picks the LAST fence when multiple fences are present", () => {
		const raw = [
			"```json",
			'{"action":"COMPLETE","agentName":"first"}',
			"```",
			"```json",
			'{"action":"COMPLETE","agentName":"last"}',
			"```",
		].join("\n");
		assert.equal(extractLastJson(raw), '{"action":"COMPLETE","agentName":"last"}');
	});

	it("extracts plain ``` fence without json language tag", () => {
		const raw = ["```", '{"action":"REJECTED","agentName":"auditor"}', "```"].join("\n");
		assert.equal(extractLastJson(raw), '{"action":"REJECTED","agentName":"auditor"}');
	});
});

describe("extractLastJson — brace matching and filtering", () => {
	it("returns the last complete outermost {} pair from mixed text", () => {
		const raw = [
			'🔧 search_code {"pattern":"function.*{"}',
			"✓ search_code",
			"",
			'{"action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		assert.equal(extractLastJson(raw), '{"action":"COMPLETE","agentName":"architect"}');
	});

	it("filters tool lines when toolNames Set is passed", () => {
		const raw = [
			'🔧 search_code {"pattern":"function.*{"}',
			"✓ search_code",
			"",
			'{"action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const toolNames = new Set(["search_code", "read_file"]);
		assert.equal(extractLastJson(raw, toolNames), '{"action":"COMPLETE","agentName":"architect"}');
	});

	it("still strips 💭 thinking prefix before fence detection", () => {
		const raw = [
			"💭 The JSON output goes here",
			"💭 ```json",
			'💭 {"action":"COMPLETE","agentName":"thinker"}',
			"💭 ```",
		].join("\n");
		assert.equal(extractLastJson(raw), '{"action":"COMPLETE","agentName":"thinker"}');
	});

	it("applies THINKING_PREFIX_RE strip inside the scanner (live call site)", () => {
		assert.ok(THINKING_PREFIX_RE instanceof RegExp, "THINKING_PREFIX_RE must be exported");
		const withPrefix = '💭\t{"a":1}';
		assert.equal(withPrefix.replace(THINKING_PREFIX_RE, ""), '{"a":1}');
	});

	it("returns empty string when no JSON structure exists", () => {
		assert.equal(extractLastJson("just some prose, no braces at all"), "");
		assert.equal(extractLastJson(""), "");
	});
});

// ---------------------------------------------------------------------------
// Escape-tracking parity (fenced walker vs brace walker)
// ---------------------------------------------------------------------------

/**
 * Same JSON payloads, exercised through both extraction walks. The escape
 * rule (backslash escapes the next char; unescaped `"` toggles string state)
 * must behave identically for fenced and unfenced agent output.
 */
const ESCAPE_PAYLOADS: Array<{ name: string; json: string; expected: unknown }> = [
	{
		name: "escaped quotes plus braces inside a value",
		json: '{"commentBody":"he said \\"hi\\" and {this} stays"}',
		expected: { commentBody: 'he said "hi" and {this} stays' },
	},
	{
		name: "value ending in escaped backslash",
		json: '{"path":"C:\\\\"}',
		expected: { path: "C:\\" },
	},
	{
		name: "nested object with escaped-backslash value",
		json: '{"outer":{"path":"C:\\\\"},"n":1}',
		expected: { outer: { path: "C:\\" }, n: 1 },
	},
	{
		name: "triple backticks inside a string value",
		json: '{"commentBody":"use ``` fences \\"a\\":1 here"}',
		expected: { commentBody: 'use ``` fences "a":1 here' },
	},
	{
		name: "literal braces inside a string value",
		json: '{"commentBody":"literal { and } braces"}',
		expected: { commentBody: "literal { and } braces" },
	},
	{
		name: "escaped quote followed by a nested object",
		json: '{"a":"foo\\"bar","b":{"c":1}}',
		expected: { a: 'foo"bar', b: { c: 1 } },
	},
];

const fenced = (json: string) => "```json\n" + json + "\n```";

describe("extractLastJson — fenced walker escape tracking", () => {
	for (const { name, json, expected } of ESCAPE_PAYLOADS) {
		it(`returns the fenced payload intact: ${name}`, () => {
			assert.equal(extractLastJson(fenced(json)), json);
			assert.deepEqual(JSON.parse(extractLastJson(fenced(json))), expected);
		});
	}

	it("falls through to the brace scan when the fence is never closed", () => {
		assert.equal(extractLastJson('```json\n{"a":1}'), '{"a":1}');
	});

	it("returns empty for empty/prose input", () => {
		assert.equal(extractLastJson(""), "");
		assert.equal(extractLastJson("just some prose, no braces at all"), "");
	});
});

describe("extractLastJson — brace walker parity with the fence walker", () => {
	for (const { name, json, expected } of ESCAPE_PAYLOADS) {
		it(`unfenced result equals fenced result: ${name}`, () => {
			assert.equal(extractLastJson(json), json, "unfenced extraction");
			assert.equal(extractLastJson(json), extractLastJson(fenced(json)), "walk parity");
			assert.deepEqual(JSON.parse(extractLastJson(json)), expected);
		});
	}

	it("escaped quote followed by comma+key does not flip structural counting", () => {
		const json = '{"commentBody":"value: \\"key\\", is important"}';
		assert.equal(extractLastJson(json), json);
		assert.deepEqual(JSON.parse(extractLastJson(json)), {
			commentBody: 'value: "key", is important',
		});
	});

	it("value ending in an escaped backslash right before the closing brace", () => {
		const json = '{"a":"x\\\\"}';
		assert.equal(extractLastJson(json), json);
		assert.deepEqual(JSON.parse(extractLastJson(json)), { a: "x\\" });
	});

	it("returns empty when no complete outermost pair exists", () => {
		assert.equal(extractLastJson('{"a":{"b":1}'), "");
	});
});

describe("sanitizeJsonStrings — literal newline escaping", () => {
	it("escapes literal newlines inside string values", () => {
		const input = '{"commentBody": "line1\nline2"}';
		assert.equal(sanitizeJsonStrings(input), '{"commentBody": "line1\\nline2"}');
		assert.deepEqual(JSON.parse(sanitizeJsonStrings(input)), { commentBody: "line1\nline2" });
	});

	it("does not touch escaped quotes or backslashes", () => {
		const input = '{"a": "say \\"hi\\" \\\\ path"}';
		assert.equal(sanitizeJsonStrings(input), input);
	});
});

describe("sanitizeJsonStrings — escape tracking parity", () => {
	it("leaves correctly-escaped extraction payloads untouched", () => {
		for (const { name, json } of ESCAPE_PAYLOADS) {
			assert.equal(sanitizeJsonStrings(json), json, name);
		}
	});

	it("escapes a trailing backslash value without touching the surrounding quotes", () => {
		const json = '{"a":"x\\\\"}';
		assert.equal(sanitizeJsonStrings(json), json);
	});
});

describe("sanitizeJsonStringsConservative — content-quote retry fallback", () => {
	it("recovers unescaped content quotes followed by delimiters", () => {
		// Standard pass mis-closes the string at `"key",`; the conservative
		// retry treats the `,` as content text and keeps the string open.
		const input = '{"commentBody": "value: "key", is important"}';
		assert.throws(() => JSON.parse(sanitizeJsonStrings(input)));
		assert.deepEqual(JSON.parse(sanitizeJsonStringsConservative(input)), {
			commentBody: 'value: "key", is important',
		});
	});
});
