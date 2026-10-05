/**
 * Integration: the web_search tool contract survives the real SDK loader.
 *
 * Layer: integration — uses the real @earendil-works/pi-coding-agent jiti
 * loader (no model, no network, no provider config, no subprocess). This is
 * the registration path that surfaces `annotations`/`outputSchema` to the
 * runtime (both fields were added in pi 0.99.0).
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	discoverAndLoadExtensions,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

const EXT_ENTRY = resolve(import.meta.dirname, "../index.ts");

let sandbox: string;
let loaded: LoadExtensionsResult;

before(async () => {
	// Sandbox cwd + agentDir so discovery scans nothing but our explicit path.
	sandbox = mkdtempSync(join(tmpdir(), "web-search-annotations-"));
	loaded = await discoverAndLoadExtensions([EXT_ENTRY], sandbox, sandbox);
});

after(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function webSearchDefinition() {
	assert.deepEqual(loaded.errors, [], "web_search extension should load without errors");
	const ext = loaded.extensions[0];
	assert.ok(ext, "one extension should be loaded");
	const defined = ext.tools.get("web_search");
	assert.ok(defined, "web_search should be registered");
	return defined.definition;
}

describe("web_search annotations — real SDK loader round-trip", () => {
	it("(integration) definition carries openWorldHint", () => {
		assert.deepEqual(webSearchDefinition().annotations, {
			openWorldHint: true,
		});
	});

	it("(integration) definition carries a JSON-serializable outputSchema", () => {
		const schema = webSearchDefinition().outputSchema;
		assert.ok(schema, "outputSchema should be present");
		const roundTripped = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
		assert.equal(typeof roundTripped, "object");
	});
});
