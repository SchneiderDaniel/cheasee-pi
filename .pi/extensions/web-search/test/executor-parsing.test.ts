// ─── web-search executor: output parsing ─────────────────────────
// Split from executor.test.ts (issue #2005 Long File refactor).
// Same mock harness; scenario seam at the RS-framing parser.
/**
 * Tests for executor.ts — shSingleQuote, runSearchScript, parseSearchOutput, parseSearchResults
 *
 * Layer: (D) Domain/Unit — mock pi.exec, temp fs via fs.mkdtempSync.
 * No real Python, no network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { execFileSync } from "node:child_process";
import type { ExecResult, ExecFn } from "../types.ts";

import { FRAME } from "../protocol.ts";
import { parseSearchOutput, parseSearchResults } from "../executor.ts";
import { formatResults } from "../index.ts";

type ExecHandler = ExecFn;

/** Python string literal for FRAME — what python-script.ts interpolates. */
const FRAME_PY = JSON.stringify(FRAME);

/** Frame a payload the way the Python producer does: <RS><json><RS> */
const framed = (json: string): string => `${FRAME}${json}${FRAME}`;

function makeMockExec(): ReturnType<typeof mock.fn<ExecHandler>> {
	return mock.fn<ExecHandler>();
}

describe("parseSearchOutput — RS framing", () => {
	it("(D) extracts JSON between frames", () => {
		assert.equal(parseSearchOutput(framed('{"ok":true,"results":[]}')), '{"ok":true,"results":[]}');
	});

	it("(D) extracts JSON with trailing garbage after the closing frame", () => {
		const stdout = `${framed('{"ok":true}')}\nsome trailing garbage that got truncated`;
		assert.equal(parseSearchOutput(stdout), '{"ok":true}');
	});

	it("(D) extracts JSON with logger noise before the opening frame", () => {
		const stdout = `{bad log line}\nSEARCH_DONE\n${framed('{"ok":true}')}`;
		assert.equal(parseSearchOutput(stdout), '{"ok":true}');
	});

	it("(D) empty frame region returns null", () => {
		assert.equal(parseSearchOutput(`${FRAME}${FRAME}`), null);
	});

	it("(D) no frames at all returns null", () => {
		assert.equal(parseSearchOutput("some random output"), null);
	});

	it("(D) multi-line JSON between frames", () => {
		const json = parseSearchOutput(framed('{\n  "ok": true,\n  "results": []\n}'));
		assert.ok(json !== null, "should extract multi-line JSON");
		assert.ok(json.includes('"ok"'), "extracted text should contain JSON content");
	});

	it("(D) single (unterminated) frame returns null", () => {
		assert.equal(parseSearchOutput(`${FRAME}{"ok":true}`), null);
	});

	it("(D) extracts a payload containing literal SEARCH_OK and SEARCH_DONE verbatim", () => {
		const payload =
			'{"ok":true,"results":[{"title":"T","url":"https://x.io","snippet":"a SEARCH_DONE b SEARCH_OK c"}]}';
		assert.equal(parseSearchOutput(framed(payload)), payload);
	});
});

describe("parseSearchResults — result parsing", () => {
	it("(D) parses successful results correctly", () => {
		const stdout = framed(
			'{"ok":true,"results":[{"title":"Test","url":"https://example.com","snippet":"A test result"}]}',
		);
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].title, "Test");
			assert.equal(result.results[0].url, "https://example.com");
			assert.equal(result.results[0].snippet, "A test result");
		}
	});

	it("(D) handles error response from script", () => {
		const result = parseSearchResults(framed('{"ok":false,"error":"ddgs not installed"}'));
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("ddgs not installed"));
		}
	});

	it("(D) framing mismatch reports a framing error, not a JSON parse error", () => {
		const result = parseSearchResults("some random output");
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("No framed output found"));
			assert.ok(!result.error.includes("SyntaxError"), "must not blame the JSON parser");
			assert.ok(!result.error.includes("Failed to parse"), "must not blame the JSON parser");
		}
	});

	it("(D) handles malformed JSON inside a valid frame", () => {
		const result = parseSearchResults(framed("{broken json"));
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("Failed to parse"));
		}
	});

	it("(D) handles empty results array", () => {
		const result = parseSearchResults(framed('{"ok":true,"results":[]}'));
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 0);
		}
	});

	it("(D) regression: framed snippet containing SEARCH_DONE is preserved char-for-char", () => {
		const snippet = "discuss SEARCH_DONE protocol states";
		const stdout = framed(
			JSON.stringify({ ok: true, results: [{ title: "T", url: "https://x.io", snippet }] }),
		);
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].snippet, snippet);
		}
	});
});

describe("producer↔consumer frame round-trip (stock python3, stdlib only)", () => {
	const runPython = (program: string, input: string): string =>
		execFileSync("python3", ["-c", program], { input, encoding: "utf-8" });

	/** Same framing the SEARCH_SCRIPT emits: <RS><json.dumps(payload)><RS>\n */
	const producer = (payloadExpr: string): string =>
		`import sys, json\n` +
		`payload = json.loads(sys.stdin.read())\n` +
		`sys.stdout.write(${FRAME_PY} + ${payloadExpr} + ${FRAME_PY} + "\\n")\n`;

	it("(adapter) frames a snippet containing SEARCH_DONE and SEARCH_OK — both preserved", () => {
		const snippet = "a SEARCH_DONE b SEARCH_OK c";
		const payload = JSON.stringify({
			ok: true,
			results: [{ title: "T", url: "https://x.io", snippet }],
		});
		const stdout = runPython(producer("json.dumps(payload)"), payload);
		const extracted = parseSearchOutput(stdout);
		assert.ok(extracted !== null, "framed payload should be extracted");
		const parsed = JSON.parse(extracted);
		assert.equal(parsed.results[0].snippet, snippet);
	});

	it("(adapter) frames an error payload and round-trips it", () => {
		const payload = JSON.stringify({ ok: false, error: "ddgs not installed" });
		const stdout = runPython(producer("json.dumps(payload)"), payload);
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.equal(result.error, "ddgs not installed");
		}
	});
});

// ===========================================================================
// Phase 2 — item-level validation (malformed DDG entries are dropped)
// ===========================================================================

describe("parseSearchResults — item validation", () => {
	const payload = (results: unknown): string => framed(JSON.stringify({ ok: true, results }));

	it("(entity) results missing → { ok: true, results: [] }", () => {
		const result = parseSearchResults(framed('{"ok":true}'));
		assert.ok(result.ok === true);
		if (result.ok) assert.deepEqual(result.results, []);
	});

	it("(entity) results non-array → []", () => {
		const result = parseSearchResults(payload("not-an-array"));
		assert.ok(result.ok === true);
		if (result.ok) assert.deepEqual(result.results, []);
	});

	it("(entity) entry missing url is dropped; valid siblings retained in order", () => {
		const result = parseSearchResults(
			payload([
				{ title: "A", url: "https://a", snippet: "a" },
				{ title: "B", snippet: "no url" },
				{ title: "C", url: "https://c", snippet: "c" },
			]),
		);
		assert.ok(result.ok === true);
		if (result.ok)
			assert.deepEqual(
				result.results.map((r) => r.title),
				["A", "C"],
			);
	});

	it("(entity) entry with non-string title or snippet is dropped", () => {
		const result = parseSearchResults(
			payload([
				{ title: 7, url: "https://a", snippet: "s" },
				{ title: "B", url: "https://b", snippet: null },
				{ title: "C", url: "https://c", snippet: "c" },
			]),
		);
		assert.ok(result.ok === true);
		if (result.ok)
			assert.deepEqual(
				result.results.map((r) => r.title),
				["C"],
			);
	});

	it("(entity) non-object entries (null, string, number) are dropped, no throw", () => {
		const result = parseSearchResults(
			payload([null, "str", 7, { title: "T", url: "https://t", snippet: "s" }]),
		);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].title, "T");
		}
	});

	it("(entity) all-valid entries pass through unchanged, SEARCH_DONE/SEARCH_OK preserved", () => {
		const snippet = "a SEARCH_DONE b SEARCH_OK c";
		const result = parseSearchResults(payload([{ title: "T", url: "https://x.io", snippet }]));
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.deepEqual(result.results, [{ title: "T", url: "https://x.io", snippet }]);
		}
	});

	it("(entity) regression: validated entries yield no 'undefined' literal in formatResults", () => {
		const result = parseSearchResults(
			payload([
				{ title: "A", url: "https://a", snippet: "a" },
				{ title: "B" },
				null,
				{ url: "https://c", snippet: "c" },
			]),
		);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.ok(!formatResults(result.results).includes("undefined"));
		}
	});
});
