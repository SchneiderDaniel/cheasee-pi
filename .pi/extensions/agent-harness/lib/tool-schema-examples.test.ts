/**
 * Tests for tool-schema-examples.ts — manually-synchronized schema examples.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getToolSchemaExample } from "./tool-schema-examples.ts";

describe("getToolSchemaExample", () => {
	it("read returns string with absolute path and no false defaults for offset/limit", () => {
		const example = getToolSchemaExample("read");
		assert.ok(example, "should return a string for read");
		assert.ok(example!.includes('"path"'), "should include path parameter");
		assert.ok(example!.includes("/path/to/file"), "should show absolute path");
		assert.ok(!example!.includes('"offset"'), "should not include offset (optional, no default shown)");
		assert.ok(!example!.includes('"limit"'), "should not include limit (optional, no default shown)");
	});

	it("ripgrep_search returns string with all params and correct optionality", () => {
		const example = getToolSchemaExample("ripgrep_search");
		assert.ok(example, "should return a string for ripgrep_search");
		assert.ok(example!.includes('"query"'), "should include query parameter");
		assert.ok(example!.includes('"directory?"'), "should show directory as optional");
		assert.ok(example!.includes('"max_count?"'), "should show max_count as optional");
	});

	it("unknown tool returns undefined", () => {
		assert.equal(getToolSchemaExample("unknown_tool"), undefined);
	});

	it("single export — no side effects on import", async () => {
		const mod = await import("./tool-schema-examples.ts");
		const keys = Object.keys(mod).filter((k) => k !== "__esModule");
		assert.deepEqual(keys, ["getToolSchemaExample"], "should export only getToolSchemaExample");
	});
});
