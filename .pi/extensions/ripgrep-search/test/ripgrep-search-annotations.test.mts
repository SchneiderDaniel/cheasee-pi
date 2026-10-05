/**
 * Integration: the ripgrep_search tool contract survives the real SDK loader,
 * and the annotation triple flows through permission derivation.
 *
 * Layer: integration — uses the real @earendil-works/pi-coding-agent jiti
 * loader (no model, no network, no provider config, no subprocess) and the
 * pure agent-harness annotation mapper. Closes the two coverage gaps left by
 * the mock-`pi` suite: the actual registration path that surfaces
 * `annotations`/`outputSchema` to the runtime, and the exact ripgrep
 * annotation triple as consumed by the permission layer.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search-annotations.test.mts
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import {
	discoverAndLoadExtensions,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import { RipgrepSearchOutputSchema } from "../types.ts";
import { deriveToolMetaFromAnnotations } from "../../agent-harness/lib/tool-annotations.ts";
import { DESTRUCTIVE_CASCADE_THRESHOLD } from "../../agent-harness/lib/harness-rules.ts";

const EXT_ENTRY = resolve(import.meta.dirname, "../index.ts");

let sandbox: string;
let loaded: LoadExtensionsResult;

before(async () => {
	// Sandbox cwd + agentDir so discovery scans nothing but our explicit path.
	sandbox = mkdtempSync(join(tmpdir(), "ripgrep-search-annotations-"));
	loaded = await discoverAndLoadExtensions([EXT_ENTRY], sandbox, sandbox);
});

after(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function ripgrepSearchDefinition() {
	assert.deepEqual(loaded.errors, [], "ripgrep_search extension should load without errors");
	const ext = loaded.extensions[0];
	assert.ok(ext, "one extension should be loaded");
	const defined = ext.tools.get("ripgrep_search");
	assert.ok(defined, "ripgrep_search should be registered");
	return defined.definition;
}

describe("ripgrep_search — real SDK loader round-trip", () => {
	it("(integration) definition declares read-only / idempotent / closed-world hints", () => {
		assert.deepEqual(ripgrepSearchDefinition().annotations, {
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("(integration) definition.outputSchema deep-equals the declared schema", () => {
		// jiti re-instantiates the extension module, so the loader's schema object is a
		// distinct reference with identical structure — compare by value.
		assert.deepEqual(ripgrepSearchDefinition().outputSchema, RipgrepSearchOutputSchema);
	});

	it("(integration) definition.outputSchema survives a JSON round-trip", () => {
		const schema = ripgrepSearchDefinition().outputSchema;
		assert.ok(schema, "outputSchema should be present");
		const roundTripped = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
		assert.equal(typeof roundTripped, "object");
	});

	it("(integration) loaded outputSchema validates success and error payloads", () => {
		const schema = ripgrepSearchDefinition().outputSchema;
		assert.ok(schema, "outputSchema should be present");
		assert.ok(
			Value.Check(schema, {
				query: "TODO",
				searcher: "grep",
				directory: "src",
				total_returned: 1,
				results: [{ file: "a.ts", line: 1, column: 1, text: "TODO" }],
				truncated: false,
			}),
		);
		assert.ok(
			Value.Check(schema, {
				query: "TODO",
				searcher: "grep",
				directory: "src",
				total_returned: 0,
				results: [],
				truncated: false,
				error: "boom",
				code: 2,
			}),
		);
	});

	it("(integration) parameters unchanged — query required, directory/max_count optional", () => {
		const { parameters } = ripgrepSearchDefinition();
		assert.ok(Value.Check(parameters, { query: "x" }));
		assert.ok(Value.Check(parameters, { query: "x", directory: "src", max_count: 5 }));
		assert.ok(!Value.Check(parameters, {}));
		assert.ok(!Value.Check(parameters, { directory: "src" }));
	});
});

describe("ripgrep_search annotations — permission derivation", () => {
	it("(integration) the exact triple moves the tool out of the destructive class", () => {
		const meta = deriveToolMetaFromAnnotations(
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			8,
		);
		assert.ok(meta, "the annotation triple should derive a meta");
		assert.equal(meta.trackErrors, false, "read-only → errors not tracked");
		assert.equal(meta.destructive, false, "read-only wins over the destructive default");
		assert.equal(meta.openWorld, false, "explicit openWorldHint:false is honored");
		assert.equal(meta.idempotent, true, "idempotentHint carried through verbatim");
		assert.equal(meta.cascadeThreshold, undefined, "no destructive escalation");
	});

	it("(integration) regression guard — absent annotations stay destructive + error-tracked", () => {
		assert.equal(deriveToolMetaFromAnnotations(undefined, 8), undefined);

		const meta = deriveToolMetaFromAnnotations({}, 8);
		assert.ok(meta, "empty annotations still derive a meta");
		assert.equal(meta.destructive, true, "MCP destructive default");
		assert.equal(meta.trackErrors, true, "not read-only");
		assert.equal(
			meta.cascadeThreshold,
			DESTRUCTIVE_CASCADE_THRESHOLD,
			"proves the triple is what moves the tool out of the destructive class",
		);
	});
});
