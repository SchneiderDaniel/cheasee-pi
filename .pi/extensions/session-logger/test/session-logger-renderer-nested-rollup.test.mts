/**
 * Tests for session-logger/renderer.ts — supervisor custom message details
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { parseSessionStats } from "../renderer.ts";

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — supervisor custom entry rendering
// ---------------------------------------------------------------------------

// Split from session-logger-renderer.test.mts (issue #2035 Long File refactor).
describe("parseSessionStats — nestedCalls rollup (JSONL authority)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-nested-stats-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-nested",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	function nestedToolResult(
		toolName: string,
		nestedCalls: { calls: Array<Record<string, unknown>>; complete: boolean },
		opts: { isError?: boolean } = {},
	) {
		return {
			type: "message",
			timestamp: "2025-06-01T10:03:00Z",
			message: {
				role: "toolResult",
				toolName,
				isError: opts.isError ?? false,
				content: [{ type: "text", text: "done" }],
				nestedCalls,
			},
		};
	}

	const COMPLETE_NESTED = {
		calls: [
			{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 120 },
			{ id: "codemode_1/2", name: "grep", status: "error", durationMs: 30, error: "boom" },
		],
		complete: true,
	};

	it("rolls nested calls, errors and durations into the parent toolStats", () => {
		const parsed = parseSessionStats(writeJsonl([nestedToolResult("codemode", COMPLETE_NESTED)]));
		assert.ok(parsed, "should parse");
		assert.deepStrictEqual(parsed.toolStats.codemode, {
			calls: 3,
			errors: 1,
			totalDurationMs: 150,
		});
	});

	it("nested tool names never become orphan tool rows", () => {
		const parsed = parseSessionStats(writeJsonl([nestedToolResult("codemode", COMPLETE_NESTED)]));
		assert.ok(parsed);
		assert.strictEqual(parsed.toolStats.read, undefined);
		assert.strictEqual(parsed.toolStats.grep, undefined);
	});

	it("records a nestedCallAnnotations entry for the parent (incomplete absent)", () => {
		const parsed = parseSessionStats(writeJsonl([nestedToolResult("codemode", COMPLETE_NESTED)]));
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.nestedCallAnnotations!.codemode, {
			nestedCalls: 2,
			nestedErrors: 1,
			nestedDurationMs: 150,
		});
		assert.strictEqual("incomplete" in parsed.nestedCallAnnotations!.codemode, false);
	});

	it("unfinished nested call is counted but is not an error", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [
						{ id: "codemode_1/1", name: "read", status: "unfinished" },
						{ id: "codemode_1/2", name: "read", status: "ok", durationMs: 10 },
					],
					complete: true,
				}),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.toolStats.codemode.calls, 3);
		assert.strictEqual(parsed.toolStats.codemode.errors, 0);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.nestedCalls, 2);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.nestedErrors, 0);
	});

	it("complete:false with omitted arguments → incomplete=arguments-omitted", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_1/1", name: "read", status: "ok", argumentsBytes: 9000 }],
					complete: false,
				}),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.incomplete, "arguments-omitted");
	});

	it("complete:false with an unfinished call → incomplete=unfinished", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_1/1", name: "read", status: "unfinished" }],
					complete: false,
				}),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.incomplete, "unfinished");
	});

	it("complete:false with no other cause → incomplete=dropped", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 5 }],
					complete: false,
				}),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.incomplete, "dropped");
	});

	it("non-nested toolResult produces no nestedCallAnnotations", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				{
					type: "message",
					timestamp: "2025-06-01T10:03:00Z",
					message: {
						role: "toolResult",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
				},
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations, undefined);
		assert.deepStrictEqual(parsed.toolStats.read, { calls: 1, errors: 0, totalDurationMs: 0 });
	});

	it("accumulates nested counts across repeated invocations of the same parent", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", COMPLETE_NESTED),
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_2/1", name: "read", status: "ok", durationMs: 50 }],
					complete: true,
				}),
			]),
		);
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.nestedCallAnnotations!.codemode, {
			nestedCalls: 3,
			nestedErrors: 1,
			nestedDurationMs: 200,
		});
		assert.deepStrictEqual(parsed.toolStats.codemode, {
			calls: 5,
			errors: 1,
			totalDurationMs: 200,
		});
	});

	it("keeps the earlier incomplete reason when a later parent result is complete", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 10 }],
					complete: false,
				}),
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_2/1", name: "read", status: "ok", durationMs: 20 }],
					complete: true,
				}),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.incomplete, "dropped");
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.nestedCalls, 2);
	});

	it("keeps the most severe incomplete reason across repeated parent results", () => {
		const parsed = parseSessionStats(
			writeJsonl([
				nestedToolResult("codemode", {
					calls: [{ id: "codemode_1/1", name: "read", status: "ok", argumentsBytes: 9000 }],
					complete: false,
				}),
				nestedToolResult("codemode", { calls: [], complete: false }),
			]),
		);
		assert.ok(parsed);
		assert.strictEqual(parsed.nestedCallAnnotations!.codemode.incomplete, "dropped");
	});
});

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — nested calls in Tool Usage table + truncation note
// ---------------------------------------------------------------------------
