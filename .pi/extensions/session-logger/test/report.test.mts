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
import type { StatsSnapshot, ToolExecution } from "../stats.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const START_BASE = 1_000_000;

function makeToolExecution(
	toolName: string,
	opts: { isError?: boolean; durationMs?: number; hasEndTime?: boolean; parentToolCallId?: string } = {},
): ToolExecution {
	const startTime = START_BASE;
	const endTime = opts.hasEndTime !== false ? startTime + (opts.durationMs ?? 100) : null;
	return {
		toolCallId: `call-${toolName}-${Date.now()}`,
		toolName,
		parentToolCallId: opts.parentToolCallId,
		isError: opts.isError ?? false,
		startTime,
		endTime,
		resultSize: 0,
	};
}

const defaultTokens = { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, total: 315 };

function makeParsed(overrides?: Partial<ParsedSessionStats>): ParsedSessionStats {
	return {
		sessionId: "test-session-1",
		timestamp: "2025-06-01T00:00:00.000Z",
		cwd: "/tmp",
		version: 1,
		entryCount: 5,
		tokens: defaultTokens,
		cost: 0.05,
		compactions: 2,
		modelChanges: [{ time: "2025-06-01T00:01:00.000Z", model: "gpt-4" }],
		thinkingChanges: [{ time: "2025-06-01T00:02:00.000Z", level: "normal" }],
		toolStats: {},
		fileModifications: [
			{ action: "write", path: "/tmp/test.txt", timestamp: "2025-06-01T00:03:00.000Z" },
		],
		perTurnTokens: [{ turnIndex: 0, tokens: 100, cost: 0.02, toolCount: 2, errorCount: 0 }],
		...overrides,
	};
}

function makeSnapshot(execs: ToolExecution[]): StatsSnapshot {
	return {
		totalInputTokens: 100,
		totalOutputTokens: 200,
		totalCacheRead: 10,
		totalCacheWrite: 5,
		totalCost: 0.05,
		modelChanges: [],
		thinkingChanges: [],
		compactionCount: 2,
		toolExecutions: execs,
		perTurnTokens: [],
		fileModifications: [],
	};
}

describe("buildMetadata — nested call merge (no double count)", () => {
	function nestedParsed(): ParsedSessionStats {
		return makeParsed({
			toolStats: { codemode: { calls: 3, errors: 1, totalDurationMs: 150 } },
			nestedCallAnnotations: {
				codemode: { nestedCalls: 2, nestedErrors: 1, nestedDurationMs: 150 },
			},
		});
	}

	function nestedSnapshot(): StatsSnapshot {
		return makeSnapshot([
			{ ...makeToolExecution("codemode", { durationMs: 500 }), toolCallId: "codemode_1" },
			{
				...makeToolExecution("read", { durationMs: 120 }),
				toolCallId: "codemode_1/1",
				parentToolCallId: "codemode_1",
			},
			{
				...makeToolExecution("grep", { durationMs: 30, isError: true }),
				toolCallId: "codemode_1/2",
				parentToolCallId: "codemode_1",
			},
		]);
	}

	it("keeps parsed calls/errors and uses the parent wall clock duration only", () => {
		const meta = buildMetadata(nestedParsed(), nestedSnapshot());
		const ts = meta.toolStats!;
		assert.strictEqual(ts.codemode.calls, 3, "nested-inclusive calls from parsed");
		assert.strictEqual(ts.codemode.errors, 1, "nested-inclusive errors from parsed");
		assert.strictEqual(
			ts.codemode.totalDurationMs,
			500,
			"parent wall clock — never parsed + snapshot",
		);
	});

	it("without a snapshot, duration is the parsed nested-duration sum", () => {
		const meta = buildMetadata(nestedParsed());
		const ts = meta.toolStats!;
		assert.strictEqual(ts.codemode.calls, 3);
		assert.strictEqual(ts.codemode.errors, 1);
		assert.strictEqual(ts.codemode.totalDurationMs, 150);
	});

	it("does not add nested-only tool names as orphan rows", () => {
		const meta = buildMetadata(nestedParsed(), nestedSnapshot());
		const ts = meta.toolStats!;
		assert.strictEqual(ts.read, undefined, "nested read not added");
		assert.strictEqual(ts.grep, undefined, "nested grep not added");
	});

	it("propagates nestedCallAnnotations onto Metadata", () => {
		const meta = buildMetadata(nestedParsed(), nestedSnapshot());
		assert.deepStrictEqual(meta.nestedCallAnnotations, {
			codemode: { nestedCalls: 2, nestedErrors: 1, nestedDurationMs: 150 },
		});
	});

	it("omits nestedCallAnnotations for non-nested sessions", () => {
		const meta = buildMetadata(
			makeParsed({ toolStats: { read: { calls: 1, errors: 0, totalDurationMs: 50 } } }),
		);
		assert.strictEqual(meta.nestedCallAnnotations, undefined);
	});

	it("non-nested input stays byte-identical through JSON.stringify", () => {
		const parsed = makeParsed({ toolStats: { read: { calls: 1, errors: 0, totalDurationMs: 0 } } });
		const snapshot = makeSnapshot([makeToolExecution("read", { durationMs: 150 })]);
		const meta = buildMetadata(parsed, snapshot);
		assert.strictEqual(JSON.stringify(meta).includes("nestedCallAnnotations"), false);
	});
});

// ---------------------------------------------------------------------------
// buildMetadata() — entity tests
// ---------------------------------------------------------------------------

describe("buildMetadata() — pure function unit tests", () => {
	it("returns Metadata with all fields mapped from parsed (no snapshot)", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed);

		assert.strictEqual(meta.sessionId, "test-session-1");
		assert.strictEqual(meta.name, undefined);
		assert.strictEqual(meta.messages, 5);
		assert.deepStrictEqual(meta.tokens, defaultTokens);
		assert.strictEqual(meta.cost, 0.05);
		assert.strictEqual(meta.compactions, 2);
		assert.deepStrictEqual(meta.modelChanges, parsed.modelChanges);
		assert.deepStrictEqual(meta.thinkingChanges, parsed.thinkingChanges);
		assert.deepStrictEqual(meta.perTurnTokens, parsed.perTurnTokens);
		assert.deepStrictEqual(meta.fileModifications, parsed.fileModifications);
	});

	it("returns toolStats from parsed when no snapshot is given", () => {
		const toolStats = {
			read: { calls: 3, errors: 1, totalDurationMs: 500 },
			write: { calls: 1, errors: 0, totalDurationMs: 200 },
		};
		const parsed = makeParsed({ toolStats });
		const meta = buildMetadata(parsed);

		assert.deepStrictEqual(meta.toolStats, toolStats);
	});

	it("overwrites totalDurationMs from snapshot while preserving parsed call/error counts", () => {
		const parsedToolStats = {
			read: { calls: 3, errors: 1, totalDurationMs: 0 },
			write: { calls: 1, errors: 0, totalDurationMs: 0 },
		};
		const parsed = makeParsed({ toolStats: parsedToolStats });

		const execs = [
			makeToolExecution("read", { durationMs: 150 }),
			makeToolExecution("read", { durationMs: 250 }),
			makeToolExecution("write", { durationMs: 400 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		// Calls from parsed preserved
		assert.strictEqual(ts.read.calls, 3, "read calls from parsed preserved");
		assert.strictEqual(ts.read.errors, 1, "read errors from parsed preserved");
		// Duration from snapshot computed
		assert.strictEqual(ts.read.totalDurationMs, 400, "read duration from snapshot");
		assert.strictEqual(ts.write.calls, 1, "write calls from parsed preserved");
		assert.strictEqual(ts.write.totalDurationMs, 400, "write duration from snapshot");
	});

	it("adds tools from snapshot that are not in parsed", () => {
		const parsed = makeParsed({ toolStats: { read: { calls: 1, errors: 0, totalDurationMs: 0 } } });
		const execs = [
			makeToolExecution("read", { durationMs: 100 }),
			makeToolExecution("write", { durationMs: 200 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		// read exists in both
		assert.strictEqual(ts.read.calls, 1, "read calls from parsed");
		assert.strictEqual(ts.read.totalDurationMs, 100, "read duration from snapshot");
		// write added from snapshot
		assert.strictEqual(ts.write.calls, 1, "write calls from snapshot");
		assert.strictEqual(ts.write.totalDurationMs, 200, "write duration from snapshot");
	});

	it("with fewer tools in snapshot than parsed, unmentioned parsed tools unchanged", () => {
		const parsedToolStats = {
			read: { calls: 2, errors: 0, totalDurationMs: 100 },
			write: { calls: 1, errors: 1, totalDurationMs: 50 },
			bash: { calls: 3, errors: 0, totalDurationMs: 300 },
		};
		const parsed = makeParsed({ toolStats: parsedToolStats });
		// snapshot only has read and bash
		const execs = [
			makeToolExecution("read", { durationMs: 500 }),
			makeToolExecution("bash", { durationMs: 999 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		// read: duration overridden
		assert.strictEqual(ts.read.totalDurationMs, 500);
		// write: unchanged (not in snapshot)
		assert.strictEqual(ts.write.calls, 1);
		assert.strictEqual(ts.write.totalDurationMs, 50);
		// bash: duration overridden
		assert.strictEqual(ts.bash.totalDurationMs, 999);
	});

	it("with empty parsed.toolStats (no tools in JSONL), all snapshot tools are added", () => {
		const parsed = makeParsed({ toolStats: {} });
		const execs = [
			makeToolExecution("read", { durationMs: 100 }),
			makeToolExecution("write", { durationMs: 200 }),
			makeToolExecution("bash", { durationMs: 300 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.calls, 1);
		assert.strictEqual(ts.read.totalDurationMs, 100);
		assert.strictEqual(ts.write.calls, 1);
		assert.strictEqual(ts.write.totalDurationMs, 200);
		assert.strictEqual(ts.bash.calls, 1);
		assert.strictEqual(ts.bash.totalDurationMs, 300);
	});

	it("with empty snapshot.toolExecutions, toolStats matches parsed exactly", () => {
		const parsedToolStats = {
			read: { calls: 1, errors: 0, totalDurationMs: 50 },
		};
		const parsed = makeParsed({ toolStats: parsedToolStats });
		const snapshot = makeSnapshot([]);
		const meta = buildMetadata(parsed, snapshot);

		assert.deepStrictEqual(meta.toolStats, parsedToolStats);
	});

	it("null endTime executions are excluded from duration, counted in calls/errors", () => {
		const parsed = makeParsed({ toolStats: {} });
		const execs = [
			makeToolExecution("bash", { isError: true, hasEndTime: false }),
			makeToolExecution("bash", { durationMs: 200 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		assert.strictEqual(ts.bash.calls, 2, "both executions counted");
		assert.strictEqual(ts.bash.errors, 1, "error counted");
		assert.strictEqual(
			ts.bash.totalDurationMs,
			200,
			"only completed execution contributes duration",
		);
	});

	it("zero-duration snapshot executions result in duration=0", () => {
		const parsed = makeParsed({ toolStats: {} });
		const execs = [makeToolExecution("read", { durationMs: 0 })];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.calls, 1);
		assert.strictEqual(ts.read.totalDurationMs, 0);
	});

	it("multiple snapshot executions for same tool sum duration", () => {
		const parsed = makeParsed({ toolStats: {} });
		const execs = [
			makeToolExecution("read", { durationMs: 100 }),
			makeToolExecution("read", { durationMs: 200 }),
			makeToolExecution("read", { durationMs: 300 }),
		];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		const ts = meta.toolStats!;
		assert.strictEqual(ts.read.calls, 3);
		assert.strictEqual(ts.read.totalDurationMs, 600);
	});

	it("all Metadata fields are populated correctly", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed);

		// Verify every Metadata field that comes from parsed
		assert.ok(meta.sessionId);
		assert.strictEqual(meta.name, undefined);
		assert.strictEqual(typeof meta.messages, "number");
		assert.ok(meta.tokens);
		assert.strictEqual(typeof meta.cost, "number");
		assert.strictEqual(typeof meta.compactions, "number");
		assert.ok(Array.isArray(meta.modelChanges));
		assert.ok(Array.isArray(meta.thinkingChanges));
		assert.ok(Array.isArray(meta.perTurnTokens));
		assert.ok(meta.toolStats);
		assert.ok(Array.isArray(meta.fileModifications));
	});

	it("returns empty object for perTurnTokens when parsed has none", () => {
		const parsed = makeParsed({ perTurnTokens: undefined });
		const meta = buildMetadata(parsed);
		assert.strictEqual(meta.perTurnTokens, undefined);
	});

	it("returns undefined fileModifications when parsed has none", () => {
		const parsed = makeParsed({ fileModifications: undefined });
		const meta = buildMetadata(parsed);
		assert.strictEqual(meta.fileModifications, undefined);
	});

	it("with mode override sets meta.mode", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed, undefined, { mode: "tui" });
		assert.strictEqual(meta.mode, "tui");
	});

	it("with sessionName override sets meta.name", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed, undefined, { sessionName: "fix-bug-123" });
		assert.strictEqual(meta.name, "fix-bug-123");
	});

	it("with both overrides sets both name and mode", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed, undefined, {
			sessionName: "fix-bug-123",
			mode: "tui",
		});
		assert.strictEqual(meta.name, "fix-bug-123");
		assert.strictEqual(meta.mode, "tui");
	});

	it("without overrides keeps name undefined and mode absent", () => {
		const parsed = makeParsed();
		const meta = buildMetadata(parsed);
		assert.strictEqual(meta.name, undefined);
		assert.strictEqual((meta as any).mode, undefined);
	});

	it("with overrides preserves all other parsed fields unchanged", () => {
		const parsed = makeParsed({ cost: 0.99, entryCount: 10 });
		const meta = buildMetadata(parsed, undefined, {
			sessionName: "test",
			mode: "rpc",
		});
		assert.strictEqual(meta.sessionId, "test-session-1");
		assert.strictEqual(meta.cost, 0.99);
		assert.strictEqual(meta.messages, 10);
		assert.deepStrictEqual(meta.tokens, defaultTokens);
		assert.strictEqual(meta.compactions, 2);
		assert.deepStrictEqual(meta.modelChanges, parsed.modelChanges);
	});

	it("overrides survive snapshot merge", () => {
		const parsed = makeParsed({
			toolStats: { read: { calls: 1, errors: 0, totalDurationMs: 0 } },
		});
		const execs = [makeToolExecution("read", { durationMs: 150 })];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot, {
			sessionName: "test-snapshot",
			mode: "json",
		});
		assert.strictEqual(meta.name, "test-snapshot");
		assert.strictEqual(meta.mode, "json");
		// Tool stats still merged correctly
		assert.strictEqual(meta.toolStats!.read.totalDurationMs, 150);
	});

	it("buildMetadata is a function (exported from report.ts)", () => {
		assert.strictEqual(typeof buildMetadata, "function", "buildMetadata should be a function");
	});

	it("buildMetadata returns metadata with subagentToolStats set from parsed stats when present", () => {
		const subagentStats = {
			researcher: {
				read: { calls: 3, errors: 1, totalDurationMs: 500 },
				web_search: { calls: 2, errors: 0, totalDurationMs: 300 },
			},
			developer: {
				bash: { calls: 5, errors: 0, totalDurationMs: 1000 },
			},
		};
		const parsed = makeParsed({ subagentToolStats: subagentStats });
		const meta = buildMetadata(parsed);

		assert.ok(meta.subagentToolStats, "subagentToolStats should be present");
		assert.deepStrictEqual(meta.subagentToolStats, subagentStats, "should match parsed stats");
	});

	it("buildMetadata returns metadata without subagentToolStats when parsed has none (non-supervisor session)", () => {
		const parsed = makeParsed(); // no subagentToolStats
		const meta = buildMetadata(parsed);

		assert.strictEqual(meta.subagentToolStats, undefined, "subagentToolStats should be undefined");
	});

	it("snapshot timing merge does NOT affect subagentToolStats — unmodified passthrough", () => {
		const subagentStats = {
			researcher: {
				read: { calls: 3, errors: 1, totalDurationMs: 500 },
			},
		};
		const parsed = makeParsed({
			subagentToolStats: subagentStats,
			toolStats: { read: { calls: 1, errors: 0, totalDurationMs: 0 } },
		});
		const execs = [makeToolExecution("read", { durationMs: 150 })];
		const snapshot = makeSnapshot(execs);
		const meta = buildMetadata(parsed, snapshot);

		// subagentToolStats unchanged
		assert.deepStrictEqual(
			meta.subagentToolStats,
			subagentStats,
			"subagentToolStats unchanged after snapshot merge",
		);
		// toolStats still merged as before
		assert.strictEqual(meta.toolStats!.read.totalDurationMs, 150, "toolStats duration from snapshot");
	});

	it("overrides (sessionName, mode) do not affect subagentToolStats", () => {
		const subagentStats = {
			researcher: {
				read: { calls: 1, errors: 0, totalDurationMs: 100 },
			},
		};
		const parsed = makeParsed({ subagentToolStats: subagentStats });
		const meta = buildMetadata(parsed, undefined, { sessionName: "test", mode: "tui" });

		assert.strictEqual(meta.name, "test");
		assert.strictEqual(meta.mode, "tui");
		assert.deepStrictEqual(
			meta.subagentToolStats,
			subagentStats,
			"subagentToolStats unchanged by overrides",
		);
	});
});

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
