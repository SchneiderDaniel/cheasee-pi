// ─── Phase 2: parseArgs replacement — debug.ts and handler.ts ─────
// Tests that parseSupervisorArgs is replaced with parseArgs-compatible import.
// Since the real parseArgs is not in public API at pi 0.74.0, we test
// the local wrapper that mirrors the parseArgs interface.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the parseArgs-like function from debug.ts
// The existing parseSupervisorArgs is kept but refactored.
// We test that it handles the same patterns as parseArgs would.
import { parseSupervisorArgs } from "../lib/debug.ts";

describe("parseSupervisorArgs — parseArgs-compatible interface", () => {
	it("parseSupervisorArgs is a function exported from debug.ts", () => {
		assert.equal(typeof parseSupervisorArgs, "function", "parseSupervisorArgs should be exported");
	});

	it("parseSupervisorArgs('103').issueNum is 103 (inline assertion)", () => {
		assert.equal(parseSupervisorArgs("103").issueNum, 103);
	});

	it("returns issueNum and isDebug from '103'", () => {
		const result = parseSupervisorArgs("103");
		assert.equal(result.issueNum, 103);
		assert.equal(result.isDebug, false);
	});

	it("returns issueNum and isDebug from '--debug 103'", () => {
		const result = parseSupervisorArgs("--debug 103");
		assert.equal(result.issueNum, 103);
		assert.equal(result.isDebug, true);
	});

	it("returns issueNum and isDebug from '103 --debug'", () => {
		const result = parseSupervisorArgs("103 --debug");
		assert.equal(result.issueNum, 103);
		assert.equal(result.isDebug, true);
	});

	it("returns issueNum and isDebug from '--debug 103 --other'", () => {
		const result = parseSupervisorArgs("--debug 103 --other");
		assert.equal(result.issueNum, 103);
		assert.equal(result.isDebug, true);
	});

	it("returns null issueNum for empty input", () => {
		const result = parseSupervisorArgs("");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, false);
	});

	it("returns null issueNum for undefined input", () => {
		const result = parseSupervisorArgs(undefined);
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, false);
	});

	it("returns null issueNum for whitespace-only input", () => {
		const result = parseSupervisorArgs("   ");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, false);
	});

	it("returns debug=true and null issueNum for '--debug' alone", () => {
		const result = parseSupervisorArgs("--debug");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, true);
	});

	it("returns null issueNum for non-numeric argument without --debug", () => {
		const result = parseSupervisorArgs("abc");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, false);
	});

	it("returns null issueNum for negative numbers", () => {
		const result = parseSupervisorArgs("-1");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, false);
	});

	it("handles '--debug' with non-numeric argument", () => {
		const result = parseSupervisorArgs("--debug abc");
		assert.equal(result.issueNum, null);
		assert.equal(result.isDebug, true);
	});
});
