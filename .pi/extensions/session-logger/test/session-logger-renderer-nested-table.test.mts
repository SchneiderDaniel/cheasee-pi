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
import { renderSessionToMarkdown } from "../renderer.ts";

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — supervisor custom entry rendering
// ---------------------------------------------------------------------------

// Split from session-logger-renderer.test.mts (issue #2035 Long File refactor).
describe("renderSessionToMarkdown — nested calls in Tool Usage", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-nested-md-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function renderNested(nestedCalls: {
		calls: Array<Record<string, unknown>>;
		complete: boolean;
	}): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-nested-md",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const entries: Record<string, unknown>[] = [
			header,
			{
				type: "message",
				timestamp: "2025-06-01T10:03:00Z",
				message: {
					role: "toolResult",
					toolName: "codemode",
					isError: false,
					content: [{ type: "text", text: "done" }],
					nestedCalls,
				},
			},
		];
		fs.writeFileSync(filepath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
		return renderSessionToMarkdown(filepath);
	}

	it("folds nested calls/errors into the parent row and adds no orphan rows", () => {
		const md = renderNested({
			calls: [
				{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 120 },
				{ id: "codemode_1/2", name: "grep", status: "error", durationMs: 30, error: "boom" },
			],
			complete: true,
		});
		assert.ok(md.includes("| `codemode` | 3 | 1 |"), "parent row folds nested calls + errors");
		assert.ok(!md.includes("| `read` |"), "no orphan read row");
		assert.ok(!md.includes("| `grep` |"), "no orphan grep row");
	});

	it("emits a truncation note naming the parent and the dropped reason", () => {
		const md = renderNested({
			calls: [{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 5 }],
			complete: false,
		});
		assert.ok(md.includes("Nested activity incomplete"), "note present");
		assert.ok(md.includes("`codemode`"), "note names the parent");
		assert.ok(md.includes("dropped"), "note states dropped reason");
	});

	it("emits notes for unfinished and arguments-omitted reasons", () => {
		const unfinished = renderNested({
			calls: [{ id: "codemode_1/1", name: "read", status: "unfinished" }],
			complete: false,
		});
		assert.ok(unfinished.includes("unfinished"), "unfinished reason surfaced");

		const omitted = renderNested({
			calls: [{ id: "codemode_1/1", name: "read", status: "ok", argumentsBytes: 9000 }],
			complete: false,
		});
		assert.ok(omitted.includes("arguments-omitted"), "arguments-omitted surfaced");
	});

	it("emits no note for complete nested activity", () => {
		const md = renderNested({
			calls: [{ id: "codemode_1/1", name: "read", status: "ok", durationMs: 10 }],
			complete: true,
		});
		assert.ok(!md.includes("Nested activity incomplete"), "no note when complete");
	});
});
