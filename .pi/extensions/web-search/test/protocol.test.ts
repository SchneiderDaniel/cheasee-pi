/**
 * Tests for protocol.ts — RS (0x1E) framing token + parseFramedOutput
 *
 * Layer: (entity) Domain — pure functions, no infra dependencies.
 * Issue #1729: forgeable ASCII sentinels replaced by an unforgeable
 * control-character delimiter that JSON string escaping can never emit raw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRAME, parseFramedOutput } from "../protocol.ts";

const RS = "\x1e";

describe("FRAME — framing token", () => {
	it("(entity) FRAME is a single ASCII RS code point (0x1E)", () => {
		assert.equal(FRAME.length, 1, "FRAME must be exactly one code point");
		assert.equal(FRAME.charCodeAt(0), 0x1e, "FRAME must be ASCII Record Separator");
	});
});

describe("parseFramedOutput — RS framing extraction", () => {
	it("(entity) extracts JSON between frames", () => {
		assert.equal(parseFramedOutput(`${RS}{"ok":true}${RS}`), '{"ok":true}');
	});

	it("(entity) returns a compact single-line payload verbatim", () => {
		const payload = '{"ok":true,"results":[{"title":"T","url":"https://x.io","snippet":"s"}]}';
		assert.equal(parseFramedOutput(`${RS}${payload}${RS}\n`), payload);
	});

	it("(entity) preserves interior newlines in a multi-line payload", () => {
		const payload = '{\n  "ok": true,\n  "results": []\n}';
		assert.equal(parseFramedOutput(`${RS}${payload}${RS}`), payload);
	});

	it("(entity) ignores leading logger noise containing braces and newlines", () => {
		const stdout = `{bad log line}\nSEARCH_DONE\n${RS}{"ok":true}${RS}`;
		assert.equal(parseFramedOutput(stdout), '{"ok":true}');
	});

	it("(entity) ignores trailing garbage after the closing frame", () => {
		const stdout = `${RS}{"ok":true}${RS}\nsome trailing garbage`;
		assert.equal(parseFramedOutput(stdout), '{"ok":true}');
	});

	it("(entity) payload containing literal SEARCH_DONE is returned in full", () => {
		const payload = '{"snippet":"discuss SEARCH_DONE protocol states"}';
		assert.equal(parseFramedOutput(`${RS}${payload}${RS}`), payload);
	});

	it("(entity) payload containing literal SEARCH_OK is returned in full", () => {
		const payload = '{"snippet":"SEARCH_OK marker"}';
		assert.equal(parseFramedOutput(`${RS}${payload}${RS}`), payload);
	});

	it("(entity) payload containing both SEARCH_OK and SEARCH_DONE is returned in full", () => {
		const payload = '{"snippet":"a SEARCH_DONE b SEARCH_OK c"}';
		assert.equal(parseFramedOutput(`${RS}${payload}${RS}`), payload);
	});

	it("(entity) no frame present returns null", () => {
		assert.equal(parseFramedOutput("some random output"), null);
	});

	it("(entity) exactly one frame (unterminated) returns null", () => {
		assert.equal(parseFramedOutput(`${RS}{"ok":true}`), null);
	});

	it("(entity) whitespace-only region between frames returns null", () => {
		assert.equal(parseFramedOutput(`${RS}   \n\t${RS}`), null);
	});

	it("(entity) returned payload contains no raw RS byte even for control-char content", () => {
		const payload = JSON.stringify({ snippet: "line1\nline2\x1f\x00" });
		const inner = parseFramedOutput(`${RS}${payload}${RS}`);
		assert.equal(inner, payload);
		assert.ok(inner !== null && !inner.includes(FRAME), "payload must not carry a raw RS byte");
	});
});
