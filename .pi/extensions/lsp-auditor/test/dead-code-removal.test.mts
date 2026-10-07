/**
 * Issue #1880: dead-code removal guards for the lsp-auditor entry point.
 *
 * Asserts the removed symbols (`ExtensionContext`, `parseArgs`, `parsedArgs`)
 * never reappear in index.ts, that the live imports/handler survive, and that
 * the README no longer advertises the removed arg-parsing capability.
 *
 * Reads sources as text — does NOT import the removed symbols.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolvePath(__dirname, "../index.ts");
const README = resolvePath(__dirname, "../README.md");

const source = readFileSync(INDEX_TS, "utf8");
const readme = readFileSync(README, "utf8");

describe("dead-code removal — index.ts banned symbols", () => {
	it("does not reference ExtensionContext", () => {
		assert.strictEqual(source.includes("ExtensionContext"), false);
	});

	it("does not reference parseArgs", () => {
		assert.strictEqual(source.includes("parseArgs"), false);
	});

	it("does not reference parsedArgs", () => {
		assert.strictEqual(source.includes("parsedArgs"), false);
	});
});

describe("dead-code removal — live symbols preserved", () => {
	it("still imports ExtensionAPI from the SDK", () => {
		assert.match(source, /import type \{[^}]*\bExtensionAPI\b[^}]*\} from "@earendil-works\/pi-coding-agent"/);
	});

	it("still imports runPreAudit from ./run-pre-audit.ts", () => {
		assert.match(source, /import \{[^}]*\brunPreAudit\b[^}]*\} from "\.\/run-pre-audit\.ts"/);
	});

	it("handler signature still contains _args", () => {
		assert.match(source, /handler: async \(_args, ctx\)/);
	});
});

describe("dead-code removal — README truthfulness", () => {
	it("drops the 'Args parsing support' bullet", () => {
		assert.strictEqual(readme.includes("Args parsing support"), false);
	});

	it("drops the parseArgs requirement line", () => {
		assert.strictEqual(readme.includes("parseArgs"), false);
	});

	it("still documents mode-adaptive output", () => {
		assert.ok(readme.includes("Mode-adaptive output"), "README should still document ctx.mode");
	});
});
