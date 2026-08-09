/**
 * Tests for session-logger timing bridge — computeToolStats + merge logic
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-timing.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { computeToolStats } from "../stats.ts";
import { buildMetadata } from "../report.ts";
import type { ToolExecution } from "../stats.ts";
import { parseSessionStats } from "../renderer.ts";
import type { Metadata } from "../types.ts";

// Helper: build ToolExecution objects
const START_BASE = 1_000_000;

function makeExec(
	toolName: string,
	opts: { isError?: boolean; durationMs?: number; hasEndTime?: boolean } = {},
): ToolExecution {
	const startTime = START_BASE;
	const endTime = opts.hasEndTime !== false ? startTime + (opts.durationMs ?? 100) : null;
	return {
		toolCallId: `call-${toolName}-${Date.now()}`,
		toolName,
		isError: opts.isError ?? false,
		startTime,
		endTime,
		resultSize: 0,
	};
}

// =========================================================================
// computeToolStats — pure function unit tests
// =========================================================================

describe("computeToolStats", () => {
	it("returns empty stats for empty executions array", () => {
		const result = computeToolStats([]);
		assert.deepStrictEqual(result, {});
	});

	it("computes single tool execution duration correctly", () => {
		const execs = [makeExec("read", { durationMs: 500 })];
		const result = computeToolStats(execs);
		assert.deepStrictEqual(result, {
			read: { calls: 1, errors: 0, totalDurationMs: 500 },
		});
	});

	it("sums duration across multiple executions of same tool", () => {
		const execs = [
			makeExec("read", { durationMs: 100 }),
			makeExec("read", { durationMs: 200 }),
			makeExec("read", { durationMs: 300 }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 3);
		assert.strictEqual(result.read.totalDurationMs, 600);
	});

	it("counts errors correctly", () => {
		const execs = [
			makeExec("bash", { isError: true, durationMs: 50 }),
			makeExec("bash", { durationMs: 100 }),
			makeExec("bash", { isError: true, durationMs: 75 }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.bash.calls, 3);
		assert.strictEqual(result.bash.errors, 2);
		assert.strictEqual(result.bash.totalDurationMs, 225);
	});

	it("handles tools without endTime (in-flight) — excludes from duration", () => {
		const execs = [
			makeExec("read", { durationMs: 100 }),
			makeExec("write", { hasEndTime: false }),
			makeExec("bash", { durationMs: 200 }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 1);
		assert.strictEqual(result.read.totalDurationMs, 100);
		assert.strictEqual(result.write.calls, 1);
		assert.strictEqual(result.write.totalDurationMs, 0);
		assert.strictEqual(result.bash.calls, 1);
		assert.strictEqual(result.bash.totalDurationMs, 200);
	});

	it("zero-duration execution is counted as call", () => {
		const execs = [makeExec("read", { durationMs: 0 })];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 1);
		assert.strictEqual(result.read.errors, 0);
		assert.strictEqual(result.read.totalDurationMs, 0);
	});

	it("handles multiple different tools", () => {
		const execs = [
			makeExec("read", { durationMs: 100 }),
			makeExec("write", { durationMs: 200 }),
			makeExec("bash", { durationMs: 300 }),
			makeExec("read", { durationMs: 150 }),
			makeExec("edit", { durationMs: 50, isError: true }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 2);
		assert.strictEqual(result.read.totalDurationMs, 250);
		assert.strictEqual(result.write.calls, 1);
		assert.strictEqual(result.write.totalDurationMs, 200);
		assert.strictEqual(result.bash.calls, 1);
		assert.strictEqual(result.bash.totalDurationMs, 300);
		assert.strictEqual(result.edit.calls, 1);
		assert.strictEqual(result.edit.errors, 1);
		assert.strictEqual(result.edit.totalDurationMs, 50);
	});

	it("mixed in-flight and complete — only complete contribute to duration", () => {
		const execs = [
			makeExec("read", { durationMs: 100 }),
			makeExec("read", { hasEndTime: false }),
			makeExec("write", { hasEndTime: false }),
			makeExec("bash", { durationMs: 500 }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 2);
		assert.strictEqual(result.read.totalDurationMs, 100);
		assert.strictEqual(result.write.calls, 1);
		assert.strictEqual(result.write.totalDurationMs, 0);
		assert.strictEqual(result.bash.calls, 1);
		assert.strictEqual(result.bash.totalDurationMs, 500);
	});

	it("all in-flight — all durations zero", () => {
		const execs = [
			makeExec("read", { hasEndTime: false }),
			makeExec("write", { hasEndTime: false }),
		];
		const result = computeToolStats(execs);
		assert.strictEqual(result.read.calls, 1);
		assert.strictEqual(result.read.totalDurationMs, 0);
		assert.strictEqual(result.write.calls, 1);
		assert.strictEqual(result.write.totalDurationMs, 0);
	});

	it("errors with null endTime counted as errors but zero duration", () => {
		const execs = [makeExec("bash", { isError: true, hasEndTime: false })];
		const result = computeToolStats(execs);
		assert.strictEqual(result.bash.calls, 1);
		assert.strictEqual(result.bash.errors, 1);
		assert.strictEqual(result.bash.totalDurationMs, 0);
	});
});

// =========================================================================
// Merge logic integration tests
//
// Replicates the merge logic from generateMissingReports:
// 1. Parse tool stats from JSONL
// 2. Compute tool stats from snapshot toolExecutions
// 3. Merge: keep parsed call/error counts, override duration from computed
//    If a tool exists in computed but not parsed, add it fully.
// =========================================================================

describe("tool stats merge logic (snapshot integration)", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-timing-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Write JSONL with given tool names, then apply merge logic and write metadata. */
	function mergeAndWriteMetadata(
		sessionId: string,
		toolNames: string[],
		toolExecutions: ToolExecution[],
	): Metadata {
		const jsonlFile = path.join(sessionsDir, `${sessionId}.jsonl`);
		// Build JSONL with header + toolResult entries
		const header = {
			type: "session",
			id: sessionId,
			timestamp: "2025-06-01T00:00:00.000Z",
			cwd: tmpDir,
			version: 1,
		};
		const entries: any[] = [header];
		for (const tn of toolNames) {
			entries.push({
				type: "message",
				timestamp: "2025-06-01T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolName: tn,
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			});
		}
		fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

		// Parse stats from JSONL
		const parsed = parseSessionStats(jsonlFile);
		if (!parsed) throw new Error("Failed to parse JSONL");

		// Use extracted buildMetadata — same logic as generateMissingReports
		const snapshot = {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			modelChanges: [],
			thinkingChanges: [],
			compactionCount: 0,
			toolExecutions,
			perTurnTokens: [],
			fileModifications: [],
		};
		const meta = buildMetadata(parsed, snapshot);

		const metaPath = path.join(sessionsDir, `${sessionId}.metadata.json`);
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		return meta;
	}

	it("merges snapshot duration into parsed toolStats", () => {
		const execs = [
			makeExec("read", { durationMs: 150 }),
			makeExec("read", { durationMs: 250 }),
			makeExec("write", { durationMs: 400 }),
		];
		const meta = mergeAndWriteMetadata("test-merge-1", ["read", "write"], execs);

		assert.ok(meta.toolStats, "toolStats should be present");
		const ts = meta.toolStats!;
		// Parsed (JSONL) has 1 read call, computed has 2 — merge keeps parsed count
		assert.strictEqual(ts.read.calls, 1, "read calls from parsed");
		// Duration overridden from computed: 150 + 250 = 400
		assert.strictEqual(ts.read.totalDurationMs, 400, "read duration from computed");
		assert.strictEqual(ts.write.calls, 1, "write calls from parsed");
		assert.strictEqual(ts.write.totalDurationMs, 400, "write duration from computed");
	});

	it("no snapshot — totalDurationMs stays 0 (recovery path)", () => {
		const meta = mergeAndWriteMetadata("test-no-snapshot", ["read"], []);
		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.calls, 1);
		assert.strictEqual(ts.read.totalDurationMs, 0, "duration 0 without snapshot");
	});

	it("in-flight tools (no endTime) — duration only from complete execs", () => {
		const execs = [
			makeExec("bash", { durationMs: 200 }),
			{ ...makeExec("bash", { durationMs: 0 }), endTime: null },
		];
		const meta = mergeAndWriteMetadata("test-inflight", ["bash"], execs);
		const ts = meta.toolStats!;
		assert.strictEqual(ts.bash.calls, 1); // parsed count
		assert.strictEqual(ts.bash.totalDurationMs, 200); // only complete
	});

	it("tools from snapshot not in JSONL are added", () => {
		const execs = [
			makeExec("read", { durationMs: 100 }),
			makeExec("write", { durationMs: 200 }), // write not in JSONL
		];
		const meta = mergeAndWriteMetadata("test-extra-tools", ["read"], execs);
		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.calls, 1);
		assert.strictEqual(ts.read.totalDurationMs, 100);
		assert.strictEqual(ts.write.calls, 1);
		assert.strictEqual(ts.write.totalDurationMs, 200);
	});

	it("snapshot preserved across round-trip metadata.json", () => {
		const execs = [makeExec("read", { durationMs: 1234 })];
		const meta = mergeAndWriteMetadata("test-roundtrip", ["read"], execs);
		const metaPath = path.join(sessionsDir, "test-roundtrip.metadata.json");
		const loaded = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.toolStats.read.totalDurationMs, 1234);
	});

	it("multiple tools in snapshot each preserve their duration", () => {
		const execs = [
			makeExec("read", { durationMs: 111 }),
			makeExec("write", { durationMs: 222 }),
			makeExec("bash", { durationMs: 333 }),
			makeExec("edit", { durationMs: 444, isError: true }),
		];
		const meta = mergeAndWriteMetadata("test-multi", ["read", "write", "bash", "edit"], execs);
		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.totalDurationMs, 111);
		assert.strictEqual(ts.write.totalDurationMs, 222);
		assert.strictEqual(ts.bash.totalDurationMs, 333);
		assert.strictEqual(ts.edit.totalDurationMs, 444);
		// Error count comes from parsed (JSONL) — our JSONL sets isError: false
		assert.strictEqual(ts.edit.errors, 0, "errors from parsed (not set in JSONL)");
	});
});
