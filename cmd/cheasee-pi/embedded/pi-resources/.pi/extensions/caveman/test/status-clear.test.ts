/**
 * Tests: caveman status clearing should use undefined, not empty string
 *
 * The syncStatus function previously called ctx.ui.setStatus("caveman", "")
 * when level is "off" or showStatus is false.
 * This keeps an entry in the extension statuses map with "" as value,
 * causing the footer to render extra empty rows.
 *
 * Fix: change "" → undefined so the entry is properly deleted from the map.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/caveman/test/status-clear.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helper: read caveman source to verify no empty-string status clears
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const cavemanSourcePath = join(__dirname, "..", "index.ts");

function readCavemanSource(): string {
	return readFileSync(cavemanSourcePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("caveman status clearing", () => {
	it("source does NOT contain setStatus('caveman', '') — uses undefined instead", () => {
		const source = readCavemanSource();
		const lines = source.split("\n");

		const problematicLines: Array<{ line: number; text: string }> = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (
				line.includes('setStatus("caveman"') &&
				line.includes('""') &&
				!line.includes("undefined")
			) {
				problematicLines.push({ line: i + 1, text: line.trim() });
			}
		}

		assert.equal(
			problematicLines.length,
			0,
			`Found ${problematicLines.length} problematic line(s) with setStatus("caveman", ""):\n` +
				problematicLines.map((l) => `  Line ${l.line}: ${l.text}`).join("\n") +
				"\nChange to setStatus('caveman', undefined) instead.",
		);
	});

	it("no empty-string status calls in source", () => {
		// Verify the fix is applied — all status clears use undefined
		const source = readCavemanSource();

		// Count all occurrences of setStatus("caveman", "") — should be 0
		const matches = source.match(/setStatus\("caveman",\s*""\)/g);
		assert.equal(
			matches,
			null,
			`Found ${matches?.length || 0} occurrence(s) of setStatus("caveman", "") in index.ts.\n` +
				"All status clears should use undefined instead of empty string.",
		);
	});
});
