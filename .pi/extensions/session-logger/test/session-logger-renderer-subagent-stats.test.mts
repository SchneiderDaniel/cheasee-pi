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
describe("parseSessionStats — subagent tool calls from supervisor custom entries", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-subagent-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-subagent",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("merges subagent tool calls into toolStats alongside native toolResult counts", () => {
		const filepath = writeJsonl([
			// Native toolResult
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "content" }],
				},
			},
			// Subagent tool-complete
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "read",
					agentName: "researcher",
					isError: false,
					toolDurationMs: 500,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(
			parsed.toolStats.read.calls,
			2,
			"2 read calls total (1 native + 1 subagent)",
		);
	});

	it("extracts per-agent subagentToolStats breakdown", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "read",
					agentName: "researcher",
					isError: false,
					toolDurationMs: 200,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: false,
					toolDurationMs: 300,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.ok(parsed.subagentToolStats, "should have subagentToolStats");
		assert.strictEqual(
			parsed.subagentToolStats!["researcher"]["read"].calls,
			1,
			"researcher has 1 read call",
		);
		assert.strictEqual(
			parsed.subagentToolStats!["developer"]["bash"].calls,
			1,
			"developer has 1 bash call",
		);
	});

	it("subagent tool-complete with isError increments error count", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: true,
					toolDurationMs: 100,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.toolStats.bash.errors, 1, "1 error in flat toolStats");
		assert.strictEqual(
			parsed.subagentToolStats!["developer"]["bash"].errors,
			1,
			"1 error in per-agent breakdown",
		);
	});

	it("supervisor entry with missing toolName (malformed) silently skipped", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					// no toolName
					agentName: "researcher",
					isError: false,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(Object.keys(parsed.toolStats).length, 0, "no tools extracted");
	});

	it("supervisor entry with missing agentName uses ? as agent key", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					// no agentName
					isError: false,
					toolDurationMs: 100,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.ok(parsed.subagentToolStats, "should have subagentToolStats");
		assert.strictEqual(parsed.subagentToolStats!["?"]["bash"].calls, 1, "uses ? as agent key");
	});

	it("non-tool-complete eventType (tool-start, thinking) ignored", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-start",
					toolName: "read",
					agentName: "researcher",
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "thinking",
					content: "hmm",
					agentName: "researcher",
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(
			Object.keys(parsed.toolStats).length,
			0,
			"no tools from non-tool-complete events",
		);
	});

	it("customType other than supervisor with eventType tool-complete ignored", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "other-plugin",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "other",
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(Object.keys(parsed.toolStats).length, 0, "non-supervisor custom ignored");
	});

	it("merged: 2 native bash + 2 subagent bash = 4 total in toolStats.bash.calls", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "ok2" }],
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: false,
					toolDurationMs: 100,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: true,
					toolDurationMs: 200,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.toolStats.bash.calls, 4, "4 bash calls total");
		assert.strictEqual(parsed.toolStats.bash.errors, 1, "1 bash error total");
		assert.strictEqual(
			parsed.toolStats.bash.totalDurationMs,
			300,
			"300ms total duration from subagent entries",
		);
	});

	it("toolDurationMs from subagent details used for totalDurationMs", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "read",
					agentName: "researcher",
					isError: false,
					toolDurationMs: 1500,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.toolStats.read.totalDurationMs, 1500, "duration from details used");
	});

	it("empty session with no supervisor entries returns subagentToolStats undefined", () => {
		const filepath = writeJsonl([]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(
			parsed.subagentToolStats,
			undefined,
			"subagentToolStats undefined for empty",
		);
	});

	it("multiple agents each contribute distinct entries", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "read",
					agentName: "researcher",
					isError: false,
					toolDurationMs: 100,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: false,
					toolDurationMs: 200,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: true,
					toolDurationMs: 300,
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.subagentToolStats!["researcher"]["read"].calls, 1);
		assert.strictEqual(parsed.subagentToolStats!["developer"]["bash"].calls, 2);
		assert.strictEqual(parsed.subagentToolStats!["developer"]["bash"].errors, 1);
		assert.strictEqual(parsed.subagentToolStats!["developer"]["bash"].totalDurationMs, 500);
	});
});

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — subagent tool calls in Tool Usage table
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseSessionStats — fileModifications action filter (Set membership)
// ---------------------------------------------------------------------------
