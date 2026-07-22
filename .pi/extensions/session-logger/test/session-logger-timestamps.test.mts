/**
 * Tests for session-logger timestamp fix — parseSessionStats + generateMissingReports
 *
 * Verifies modelChanges and thinkingChanges carry per-entry timestamps
 * instead of session header timestamp.
 *
 * Run with:
 *  node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-timestamps.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { parseSessionStats } from "../renderer.ts";
import { generateMissingReports } from "../index.ts";
import type { Metadata } from "../types.ts";

// =========================================================================
// Phase 1: parseSessionStats returns per-entry timestamps
// =========================================================================

describe("parseSessionStats — model/thinking timestamps", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-ts-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeJsonl(
		entries: Record<string, unknown>[],
		sessionOpts: { timestamp?: string } = {},
	): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-id",
			timestamp: sessionOpts.timestamp ?? "2025-01-01T12:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines);
		return filepath;
	}

	it("single model_change entry returns matching timestamp", () => {
		const filepath = makeJsonl([
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.ok(Array.isArray(parsed.modelChanges), "modelChanges is array");
		assert.strictEqual(parsed.modelChanges.length, 1);
		assert.strictEqual(parsed.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(parsed.modelChanges[0].model, "openai/gpt-4");
	});

	it("single thinking_level_change entry returns matching timestamp", () => {
		const filepath = makeJsonl([
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:06:00Z",
				thinkingLevel: "high",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.thinkingChanges.length, 1);
		assert.strictEqual(parsed.thinkingChanges[0].time, "2025-01-01T12:06:00Z");
		assert.strictEqual(parsed.thinkingChanges[0].level, "high");
	});

	it("multiple model_change entries each preserve own timestamp", () => {
		const filepath = makeJsonl([
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "model_change",
				timestamp: "2025-01-01T12:10:00Z",
				provider: "anthropic",
				modelId: "claude-3",
			},
			{
				type: "model_change",
				timestamp: "2025-01-01T12:15:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.modelChanges.length, 3);
		assert.strictEqual(parsed.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(parsed.modelChanges[1].time, "2025-01-01T12:10:00Z");
		assert.strictEqual(parsed.modelChanges[2].time, "2025-01-01T12:15:00Z");
	});

	it("multiple thinking_level_change entries each preserve own timestamp", () => {
		const filepath = makeJsonl([
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:05:00Z",
				thinkingLevel: "high",
			},
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:07:00Z",
				thinkingLevel: "medium",
			},
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:09:00Z",
				thinkingLevel: "low",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.thinkingChanges.length, 3);
		assert.strictEqual(parsed.thinkingChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(parsed.thinkingChanges[1].time, "2025-01-01T12:07:00Z");
		assert.strictEqual(parsed.thinkingChanges[2].time, "2025-01-01T12:09:00Z");
	});

	it("same model used twice at different timestamps — both entries preserved (no dedup)", () => {
		const filepath = makeJsonl([
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "model_change",
				timestamp: "2025-01-01T12:10:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.modelChanges.length, 2, "no dedup — both entries kept");
		assert.strictEqual(parsed.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(parsed.modelChanges[1].time, "2025-01-01T12:10:00Z");
	});

	it("mixed model_change and thinking_change — correct timestamp per entry", () => {
		const filepath = makeJsonl([
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:06:00Z",
				thinkingLevel: "high",
			},
			{
				type: "model_change",
				timestamp: "2025-01-01T12:07:00Z",
				provider: "anthropic",
				modelId: "claude-3",
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.modelChanges.length, 2);
		assert.strictEqual(parsed.thinkingChanges.length, 1);
		assert.strictEqual(parsed.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(parsed.modelChanges[1].time, "2025-01-01T12:07:00Z");
		assert.strictEqual(parsed.thinkingChanges[0].time, "2025-01-01T12:06:00Z");
	});

	it("no model/thinking changes — empty arrays", () => {
		const filepath = makeJsonl([]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.modelChanges, []);
		assert.deepStrictEqual(parsed.thinkingChanges, []);
	});

	it("header-only JSONL — empty modelChanges and thinkingChanges", () => {
		const filepath = path.join(tmpDir, "header-only.jsonl");
		const header = {
			type: "session",
			id: "test-header-only",
			timestamp: "2025-01-01T12:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		fs.writeFileSync(filepath, JSON.stringify(header) + "\n");
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.modelChanges, []);
		assert.deepStrictEqual(parsed.thinkingChanges, []);
	});

	it("invalid JSONL returns null", () => {
		const filepath = path.join(tmpDir, "invalid.jsonl");
		fs.writeFileSync(filepath, "not valid json\n");
		assert.throws(() => parseSessionStats(filepath));
	});

	it("regression — toolStats, fileModifications, perTurnTokens, tokens, cost all unchanged", () => {
		const filepath = makeJsonl([
			{
				type: "message",
				timestamp: "2025-01-01T12:01:00Z",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						totalTokens: 165,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "/tmp/test.txt", content: "hello" },
						},
					],
				},
			},
			{
				type: "message",
				timestamp: "2025-01-01T12:02:00Z",
				message: {
					role: "toolResult",
					toolName: "write",
					isError: false,
					content: [{ type: "text", text: "written" }],
				},
			},
		]);
		const parsed = parseSessionStats(filepath);
		assert.ok(parsed);
		assert.strictEqual(parsed.entryCount, 3); // header + 2 entries
		assert.strictEqual(parsed.tokens.total, 165);
		assert.strictEqual(parsed.cost, 0.002);
		assert.ok(parsed.toolStats?.write);
		assert.strictEqual(parsed.toolStats.write.calls, 1);
		assert.ok(Array.isArray(parsed.fileModifications));
		assert.strictEqual(parsed.fileModifications.length, 1);
		assert.ok(Array.isArray(parsed.perTurnTokens));
	});
});

// =========================================================================
// Phase 2: generateMissingReports uses parsed timestamps directly
// =========================================================================

describe("generateMissingReports — model/thinking timestamps", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-ts-gen-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(sessionId: string, entries: Record<string, unknown>[]): string {
		const filepath = path.join(sessionsDir, `${sessionId}.jsonl`);
		const header = {
			type: "session",
			id: sessionId,
			timestamp: "2025-01-01T12:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines);
		return filepath;
	}

	function loadMeta(sessionId: string): Metadata {
		const metaPath = path.join(sessionsDir, `${sessionId}.metadata.json`);
		return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
	}

	it("2 model_change entries with different timestamps — metadata preserves each", async () => {
		const sessionId = "ts-model-1";
		writeJsonl(sessionId, [
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "model_change",
				timestamp: "2025-01-01T12:10:00Z",
				provider: "anthropic",
				modelId: "claude-3",
			},
		]);
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`));
		const meta = loadMeta(sessionId);
		assert.ok(Array.isArray(meta.modelChanges));
		assert.strictEqual(meta.modelChanges.length, 2);
		assert.strictEqual(meta.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(meta.modelChanges[1].time, "2025-01-01T12:10:00Z");
	});

	it("thinking_level_change entries — metadata preserves each timestamp", async () => {
		const sessionId = "ts-think-1";
		writeJsonl(sessionId, [
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:05:00Z",
				thinkingLevel: "high",
			},
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:07:00Z",
				thinkingLevel: "medium",
			},
		]);
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`));
		const meta = loadMeta(sessionId);
		assert.strictEqual(meta.thinkingChanges.length, 2);
		assert.strictEqual(meta.thinkingChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(meta.thinkingChanges[1].time, "2025-01-01T12:07:00Z");
	});

	it("mixed model + thinking changes — all timestamps correct", async () => {
		const sessionId = "ts-mixed-1";
		writeJsonl(sessionId, [
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "thinking_level_change",
				timestamp: "2025-01-01T12:06:00Z",
				thinkingLevel: "high",
			},
		]);
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`));
		const meta = loadMeta(sessionId);
		assert.strictEqual(meta.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(meta.thinkingChanges[0].time, "2025-01-01T12:06:00Z");
	});

	it("snapshot modelChanges/thinkingChanges ignored — parsed data takes priority", async () => {
		const sessionId = "ts-snapshot-ignored";
		writeJsonl(sessionId, [
			{
				type: "model_change",
				timestamp: "2025-01-01T12:05:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
		]);
		const snapshot = {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			modelChanges: [{ time: "WRONG-TIME", model: "WRONG-MODEL" }],
			thinkingChanges: [{ time: "WRONG-TIME", level: "WRONG-LEVEL" }],
			compactionCount: 0,
			toolExecutions: [],
			perTurnTokens: [],
			fileModifications: [],
		};
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`), snapshot);
		const meta = loadMeta(sessionId);
		assert.strictEqual(meta.modelChanges.length, 1);
		assert.strictEqual(meta.modelChanges[0].time, "2025-01-01T12:05:00Z");
		assert.strictEqual(meta.modelChanges[0].model, "openai/gpt-4");
	});

	it("no model/thinking entries — metadata arrays empty", async () => {
		const sessionId = "ts-empty-1";
		writeJsonl(sessionId, []);
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`));
		const meta = loadMeta(sessionId);
		assert.deepStrictEqual(meta.modelChanges, []);
		assert.deepStrictEqual(meta.thinkingChanges, []);
	});

	it("snapshot provided but no model/thinking in parsed data — arrays empty", async () => {
		const sessionId = "ts-snapshot-empty";
		writeJsonl(sessionId, []);
		const snapshot = {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			modelChanges: [{ time: "SNAP-TIME", model: "SNAP-MODEL" }],
			thinkingChanges: [{ time: "SNAP-TIME", level: "SNAP-LEVEL" }],
			compactionCount: 0,
			toolExecutions: [],
			perTurnTokens: [],
			fileModifications: [],
		};
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`), snapshot);
		const meta = loadMeta(sessionId);
		assert.deepStrictEqual(meta.modelChanges, []);
		assert.deepStrictEqual(meta.thinkingChanges, []);
	});

	it("regression — toolStats merge still works with snapshot", async () => {
		const sessionId = "ts-merge-regression";
		writeJsonl(sessionId, [
			{
				type: "message",
				timestamp: "2025-01-01T12:01:00Z",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			},
		]);
		const snapshot = {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			modelChanges: [],
			thinkingChanges: [],
			compactionCount: 0,
			toolExecutions: [
				{
					toolCallId: "call-1",
					toolName: "bash",
					startTime: 1000,
					endTime: 2500,
					isError: false,
					resultSize: 0,
				},
			],
			perTurnTokens: [],
			fileModifications: [],
		};
		await generateMissingReports(path.join(sessionsDir, `${sessionId}.jsonl`), snapshot);
		const meta = loadMeta(sessionId);
		// Parsed has 1 call, snapshot has 1500ms duration
		assert.strictEqual(meta.toolStats?.bash?.calls, 1);
		assert.strictEqual(meta.toolStats?.bash?.totalDurationMs, 1500);
	});
});
