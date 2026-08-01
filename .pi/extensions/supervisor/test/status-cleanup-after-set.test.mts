/**
 * Tests: supervisor status cleanup after setStatus("supervisor", "text")
 *
 * Every ctx.ui.setStatus("supervisor", "some text") call must have a
 * matching ctx.ui.setStatus("supervisor", undefined) in a finally block
 * or equivalent cleanup path. Otherwise the status text persists in the
 * extension statuses map, causing the footer to render extra rows.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/status-cleanup-after-set.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helper: scan source files for setStatus("supervisor", ...) patterns
// and verify each has matching cleanup.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StatusCall {
	line: number;
	text: string;
	arg: string; // the second argument to setStatus
}

/**
 * Find all setStatus("supervisor", ...) calls in a file.
 */
function findSetStatusCalls(filePath: string): StatusCall[] {
	const source = readFileSync(filePath, "utf-8");
	const lines = source.split("\n");
	const calls: StatusCall[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const match = line.match(/setStatus\("supervisor",\s*(.+)\)/);
		if (match) {
			calls.push({
				line: i + 1,
				text: line.trim(),
				arg: match[1]!.trim(),
			});
		}
	}

	return calls;
}

/**
 * Check that a file (or ordered list of files) properly clears status
 * after setting it. For every setStatus("supervisor", "text") call, there
 * must be a setStatus("supervisor", undefined) call later in the stream.
 *
 * This is a heuristic check: we verify that for every non-undefined setStatus
 * call, there is at least one undefined setStatus call after it. Files are
 * concatenated in the order given so the terminal clear (which lives in
 * post-pipeline.ts for the handler package) counts for sets in earlier files.
 */
function checkStatusCleanup(filePaths: string[]): string[] {
	const errors: string[] = [];
	let lineOffset = 0;

	const calls: StatusCall[] = [];
	for (const filePath of filePaths) {
		const fileCalls = findSetStatusCalls(filePath).map((c) => ({
			...c,
			line: c.line + lineOffset,
		}));
		calls.push(...fileCalls);
		// Line offset tracks position across concatenated files so ordering
		// is comparable across the whole stream.
		lineOffset += readFileSync(filePath, "utf-8").split("\n").length;
	}

	// Separate into set (non-undefined) and clear (undefined) calls
	const setCalls = calls.filter((c) => c.arg !== "undefined");
	const clearCalls = calls.filter((c) => c.arg === "undefined");

	// Check each set call has a matching clear after it
	for (const setCall of setCalls) {
		const clearsAfter = clearCalls.filter((c) => c.line > setCall.line);
		if (clearsAfter.length === 0) {
			errors.push(
				`Line ${setCall.line}: ${setCall.text} has no matching clear (setStatus("supervisor", undefined)) after it`,
			);
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Issue #1395 split: the handler megahandler moved to the handler package.
// preflight.ts sets "Reading project board..." etc., agent-loop.ts sets the
// per-iteration "Status: ...", and post-pipeline.ts clears on completion —
// so the package is scanned as one ordered stream.
const FILES_TO_CHECK: Array<string | string[]> = [
	"pipeline/audit.ts",
	"pipeline/merge.ts",
	"pipeline/notifications.ts",
	[
		"pipeline/handler/index.ts",
		"pipeline/handler/preflight.ts",
		"pipeline/handler/agent-loop.ts",
		"pipeline/handler/post-pipeline.ts",
		"pipeline/handler/shared.ts",
	],
];

for (const file of FILES_TO_CHECK) {
	const paths = Array.isArray(file) ? file : [file];
	const label = Array.isArray(file) ? `pipeline/handler package (${file.length} files)` : file;

	describe(`supervisor status cleanup — ${label}`, () => {
		it("every setStatus('supervisor', text) has a matching clear (setStatus with undefined) after it", () => {
			const errors = checkStatusCleanup(paths.map((p) => join(__dirname, "../", p)));
			assert.equal(
				errors.length,
				0,
				`Found ${errors.length} status(es) without cleanup in ${label}:\n` +
					errors.join("\n") +
					"\n\nEach setStatus('supervisor', 'text') must be followed by setStatus('supervisor', undefined) in a finally block.",
			);
		});
	});
}
