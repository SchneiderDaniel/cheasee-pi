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
