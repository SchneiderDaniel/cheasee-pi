/**
 * Docs contract: `README.md` and `docs/extensions/scrapling.md` must document
 * web_crawl's machine-facing contract (outputSchema / structuredContent /
 * annotations) at parity with web-search.
 *
 * Expected keys are derived from the live `crawlOutputSchema` and the real
 * registered definition (via the SDK loader) — never copied — so a schema or
 * annotation rename fails here instead of drifting silently in the docs.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	discoverAndLoadExtensions,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { crawlOutputSchema } from "../structured-output.ts";

const HERE = import.meta.dirname;
const EXT_ENTRY = resolve(HERE, "../index.ts");

const DOCS: Record<string, string> = {
	"README.md": resolve(HERE, "../README.md"),
	"docs/extensions/scrapling.md": resolve(HERE, "../../../../docs/extensions/scrapling.md"),
};

// TypeBox `Type.Union` → { anyOf: [success, error] }. Derive the key sets from
// the concrete branches so this suite tracks the schema rather than a copy.
const schemaAny = crawlOutputSchema as unknown as {
	anyOf: Array<{ properties: Record<string, any> }>;
};
const success = schemaAny.anyOf.find((b) => b.properties.ok?.const === true);
const failure = schemaAny.anyOf.find((b) => b.properties.ok?.const === false);
assert.ok(success && failure, "crawlOutputSchema must expose ok:true / ok:false branches");

const successKeys = Object.keys(success.properties);
const pageKeys = Object.keys(success.properties.pages.items.properties);
const errorKeys = Object.keys(failure.properties.error.properties);

let sandbox: string;
let loaded: LoadExtensionsResult;

before(async () => {
	sandbox = mkdtempSync(join(tmpdir(), "scrapling-readme-contract-"));
	loaded = await discoverAndLoadExtensions([EXT_ENTRY], sandbox, sandbox);
});

after(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function annotationKeys(): string[] {
	assert.deepEqual(loaded.errors, [], "web_crawl extension should load without errors");
	const def = loaded.extensions[0]?.tools.get("web_crawl")?.definition;
	assert.ok(def, "web_crawl should be registered");
	assert.ok(def.annotations, "web_crawl should declare annotations");
	return Object.keys(def.annotations);
}

describe("scrapling docs — machine-facing contract parity", () => {
	for (const [label, path] of Object.entries(DOCS)) {
		it(`${label} documents outputSchema + structuredContent + annotations`, () => {
			const doc = readFileSync(path, "utf8");
			assert.ok(doc.trim().length > 0, `${label} must be non-empty`);
			for (const term of ["outputSchema", "structuredContent", "annotations"]) {
				assert.ok(doc.includes(term), `${label} must document \`${term}\``);
			}
		});

		it(`${label} names every registered annotation key`, () => {
			const doc = readFileSync(path, "utf8");
			const keys = annotationKeys();
			assert.ok(keys.length > 0, "registered annotations must expose at least one key");
			for (const key of keys) {
				assert.ok(doc.includes(key), `${label} must name annotation \`${key}\``);
			}
		});

		it(`${label} names every success-branch key from crawlOutputSchema`, () => {
			const doc = readFileSync(path, "utf8");
			for (const key of successKeys) {
				assert.ok(doc.includes(key), `${label} must name success-branch key \`${key}\``);
			}
		});

		it(`${label} names every per-page key from crawlOutputSchema`, () => {
			const doc = readFileSync(path, "utf8");
			for (const key of pageKeys) {
				assert.ok(doc.includes(key), `${label} must name per-page key \`${key}\``);
			}
		});

		it(`${label} describes the error branch and isError signaling`, () => {
			const doc = readFileSync(path, "utf8");
			assert.ok(doc.includes("ok: false"), `${label} must show the \`ok: false\` branch`);
			for (const key of errorKeys) {
				assert.ok(doc.includes(key), `${label} must name error-branch key \`${key}\``);
			}
			assert.ok(doc.includes("isError"), `${label} must document \`isError\` signaling`);
		});

		it(`${label} states readOnlyHint is set (no "omitted" claim)`, () => {
			const doc = readFileSync(path, "utf8");
			assert.ok(doc.includes("readOnlyHint"), `${label} must mention \`readOnlyHint\``);
			assert.ok(
				!/readOnlyHint[^.]*\bomitted\b/i.test(doc),
				`${label} must not claim readOnlyHint is omitted`,
			);
		});
	}
});
