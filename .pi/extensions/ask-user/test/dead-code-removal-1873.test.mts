/**
 * Verification tests for dead code removal (Issue #1873).
 *
 * Confirms that the unused named import `readQnaEntries` is removed from
 * `.pi/extensions/ask-user/index.ts`, while `jsonl-logger.ts` keeps exporting
 * and internally using `readQnaEntries`.
 *
 * Note: the removed symbol is never statically imported here — verification is
 * via file-content assertions and dynamic import() of the survivor export.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/dead-code-removal-1873.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../index.ts");
const loggerPath = path.resolve(__dirname, "../jsonl-logger.ts");

/** Extract the `./jsonl-logger.ts` import block from index.ts source text. */
function loggerImportBlock(source: string): string {
	const match = source.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/jsonl-logger\.ts["']/s);
	assert.ok(match, "Expected a `./jsonl-logger.ts` import block in index.ts");
	return match[1];
}

describe("dead code removal — Issue #1873 (unused readQnaEntries import)", () => {
	it("no longer imports readQnaEntries in the ./jsonl-logger.ts import block", () => {
		const block = loggerImportBlock(fs.readFileSync(indexPath, "utf-8"));
		assert.ok(
			!block.includes("readQnaEntries"),
			`Expected readQnaEntries to be removed, but import block is:\n${block}`,
		);
	});

	it("keeps the other jsonl-logger.ts specifiers (surgical removal)", () => {
		const block = loggerImportBlock(fs.readFileSync(indexPath, "utf-8"));
		for (const specifier of [
			"migrateIfCsvExists",
			"listQnaEntries",
			"getQnaEntry",
			"queryQnaEntries",
		]) {
			assert.ok(
				block.includes(specifier),
				`Expected "${specifier}" to remain in the ./jsonl-logger.ts import block`,
			);
		}
	});

	it("keeps index.ts public surface intact", () => {
		const content = fs.readFileSync(indexPath, "utf-8");
		for (const decl of ["export default", "ToolResult", "successResult"]) {
			assert.ok(content.includes(decl), `Expected "${decl}" to remain in index.ts`);
		}
	});

	it("jsonl-logger.ts still exports readQnaEntries", () => {
		const content = fs.readFileSync(loggerPath, "utf-8");
		assert.ok(
			content.includes("export async function readQnaEntries"),
			"Expected readQnaEntries to remain exported from jsonl-logger.ts",
		);
	});

	it("jsonl-logger.ts still calls readQnaEntries internally (>=3 call sites)", () => {
		const content = fs.readFileSync(loggerPath, "utf-8");
		const callSites = content.match(/await readQnaEntries\(/g) ?? [];
		assert.ok(
			callSites.length >= 3,
			`Expected >=3 internal readQnaEntries call sites, found ${callSites.length}`,
		);
	});

	it("readQnaEntries remains a callable module export", async () => {
		const mod = await import("../jsonl-logger.ts");
		assert.strictEqual(typeof mod.readQnaEntries, "function");
	});
});
