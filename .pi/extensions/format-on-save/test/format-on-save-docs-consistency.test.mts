/**
 * Verify format-on-save docs are consistent with the implementation.
 *
 * Issue #1730: The README and published docs claimed a 5MB size gate, but
 * `MAX_FILE_SIZE_BYTES` is 1MB (1_048_576). This test derives the expected
 * label from the exported constant so the doc/code pair cannot re-drift.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MAX_FILE_SIZE_BYTES } from "../index.ts";

const README_PATH = resolve(import.meta.dirname, "..", "README.md");
const DOC_PATH = resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"docs",
	"extensions",
	"format-on-save.md",
);

const derivedMB = Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024);
const files = [
	["README.md", README_PATH],
	["docs/extensions/format-on-save.md", DOC_PATH],
] as const;

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

// ── Phase 1: Constant regression guard ───────────────────────────

describe("Phase 1: Size-gate constant is unchanged", () => {
	it("MAX_FILE_SIZE_BYTES === 1_048_576", () => {
		assert.strictEqual(MAX_FILE_SIZE_BYTES, 1_048_576);
	});

	it("derived MB label is 1", () => {
		assert.strictEqual(derivedMB, 1);
	});
});

// ── Phase 2: Docs contain no stale threshold ─────────────────────

describe("Phase 2: Neither doc restates a stale threshold", () => {
	for (const [name, path] of files) {
		it(`${name} is non-empty`, () => {
			assert.ok(read(path).trim().length > 0, `${name} should not be empty`);
		});

		it(`${name} contains no '5MB' (case-insensitive)`, () => {
			assert.ok(!/5\s*mb/i.test(read(path)), `${name} should not contain '5MB'`);
		});

		it(`${name} contains no '5 * 1024 * 1024'`, () => {
			assert.ok(
				!read(path).includes("5 * 1024 * 1024"),
				`${name} should not contain the stale literal '5 * 1024 * 1024'`,
			);
		});

		it(`${name} contains the derived '${derivedMB}MB' label`, () => {
			assert.ok(
				read(path).includes(`${derivedMB}MB`),
				`${name} should state the threshold as '${derivedMB}MB'`,
			);
		});

		it(`${name} contains the constant's byte value`, () => {
			const content = read(path);
			assert.ok(
				content.includes("1_048_576") || content.includes("1048576"),
				`${name} should state the byte value of MAX_FILE_SIZE_BYTES`,
			);
		});
	}
});

// ── Phase 3: No other MB token near a size-gate phrase ───────────

describe("Phase 3: Only the derived MB label appears near size-gate phrases", () => {
	for (const [name, path] of files) {
		it(`${name} has no other MB token adjacent to a size phrase`, () => {
			const content = read(path);
			// Any "NMB" token sitting next to a size-gate phrase must be the derived one.
			const pattern = /(size|Size|≤|<)[^\n]{0,40}?(\d+)\s*MB/gi;
			const offenders: string[] = [];
			for (const match of content.matchAll(pattern)) {
				if (Number(match[2]) !== derivedMB) offenders.push(match[0]);
			}
			assert.deepStrictEqual(
				offenders,
				[],
				`${name} has non-derived MB tokens near size phrases: ${offenders.join(", ")}`,
			);
		});
	}
});
