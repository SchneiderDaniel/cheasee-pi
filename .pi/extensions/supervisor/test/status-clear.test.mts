/**
 * Tests: supervisor status clearing should use undefined, not empty string
 *
 * Multiple supervisor files previously called ctx.ui.setStatus("supervisor", "")
 * when cleaning up after agent runs. This keeps entries in the extension statuses
 * map with "" as value, causing the footer to render extra empty rows.
 *
 * Fix: change "" → undefined so the entry is properly deleted from the map.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/status-clear.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helper: scan source files for problematic empty-string status clears
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES_TO_CHECK = [
	"agent/session-runner.ts",
	"agent/runner.ts",
	"pipeline/handler.ts",
	"pipeline/notifications.ts",
];

interface ProblematicLine {
	file: string;
	line: number;
	text: string;
}

function checkFile(filePath: string): ProblematicLine[] {
	const source = readFileSync(filePath, "utf-8");
	const lines = source.split("\n");
	const problems: ProblematicLine[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (
			line.includes('setStatus("supervisor"') &&
			line.includes('""') &&
			!line.includes("undefined")
		) {
			problems.push({
				file: filePath,
				line: i + 1,
				text: line.trim(),
			});
		}
	}

	return problems;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const file of FILES_TO_CHECK) {
	const filePath = join(__dirname, "../", file);

	describe(`supervisor status clearing — ${file}`, () => {
		it("does NOT contain setStatus('supervisor', '') — uses undefined instead", () => {
			const problems = checkFile(filePath);

			assert.equal(
				problems.length,
				0,
				`Found ${problems.length} problematic line(s) in ${file}:\n` +
					problems.map((p) => `  Line ${p.line}: ${p.text}`).join("\n") +
					"\nChange to setStatus('supervisor', undefined) instead.",
			);
		});
	});
}
