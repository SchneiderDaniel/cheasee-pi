/**
 * Tests for buildMetadata() — extracted metadata construction function
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/report.test.mts
 *
 * These tests validate the extracted pure function independent of file I/O.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildMetadata } from "../report.ts";
import { renderSessionToMarkdown, parseSessionStats } from "../renderer.ts";
import type { ParsedSessionStats } from "../renderer.ts";

// Split from report.test.mts (issue #2035 Long File refactor).

// ---------------------------------------------------------------------------
// Phase 8 — user journey: operator reads a nested session report
// ---------------------------------------------------------------------------

describe("user journey — operator reads a nested session report", () => {
	it("md and metadata agree on the parent call/error tallies", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-journey-"));
		try {
			const filepath = path.join(tmpDir, "journey.jsonl");
			const entries = [
				{
					type: "session",
					id: "journey",
					timestamp: "2025-06-01T10:00:00Z",
					cwd: "/tmp",
					version: 1,
				},
				{
					type: "message",
					timestamp: "2025-06-01T10:03:00Z",
					message: {
						role: "toolResult",
						toolName: "codemode",
						isError: false,
						content: [{ type: "text", text: "done" }],
						nestedCalls: {
							calls: [
								{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 120 },
								{
									id: "codemode_1/2",
									name: "grep",
									status: "error",
									durationMs: 30,
									error: "boom",
								},
							],
							complete: true,
						},
					},
				},
			];
			fs.writeFileSync(filepath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

			const parsed = parseSessionStats(filepath);
			assert.ok(parsed, "parse succeeds");
			const meta = buildMetadata(parsed);
			const md = renderSessionToMarkdown(filepath);

			// Both surfaces fold the same nested calls/errors into the parent row.
			assert.deepStrictEqual(meta.toolStats!.codemode, {
				calls: 3,
				errors: 1,
				totalDurationMs: 150,
			});
			assert.ok(md.includes("| `codemode` | 3 | 1 |"), "md table agrees with metadata");
			assert.ok(!md.includes("| `read` |") && !md.includes("| `grep` |"), "no orphan rows");
			assert.deepStrictEqual(meta.nestedCallAnnotations!.codemode, {
				nestedCalls: 2,
				nestedErrors: 1,
				nestedDurationMs: 150,
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
