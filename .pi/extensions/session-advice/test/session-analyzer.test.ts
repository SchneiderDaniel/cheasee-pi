/**
 * Tests for session-analyzer.ts — analyzeSession dedup/merge + buildSessionAnalysis
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/session-analyzer.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { analyzeSession, buildSessionAnalysis } from "../session-analyzer.ts";
import { makeSession, readEntry, bashEntry } from "./session-test-helpers.ts";

// ── Dedup / Merge tests ──

describe("analyzeSession — dedup/merge", () => {
	it("2 detectors produce same signal|toolName|files key → merged into 1 signal", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		assert.strictEqual(
			analyzeSession(data).filter((s) => s.signal === "redundant-read").length,
			1,
			"should merge into 1 signal",
		);
	});

	it("2 detectors produce different keys → 2 separate signals", () => {
		const data = makeSession([
			bashEntry("cat file | grep foo", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		const signals = analyzeSession(data);
		assert.ok(
			signals.some((s) => s.signal === "bash-grep"),
			"should have bash-grep signal",
		);
		assert.ok(
			signals.some((s) => s.signal === "redundant-read"),
			"should have redundant-read signal",
		);
	});

	it("sorted by wastedTokens descending", () => {
		const data = makeSession([
			bashEntry("cat file | grep foo", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		const signals = analyzeSession(data);
		for (let i = 1; i < signals.length; i++) {
			assert.ok(
				signals[i - 1].wastedTokens >= signals[i].wastedTokens,
				"signals should be sorted by wastedTokens desc",
			);
		}
	});

	it("empty session → empty array", () => {
		assert.strictEqual(analyzeSession(makeSession([])).length, 0);
	});

	it("D3 (bash-grep) and D4 (bash-cat) with same toolName → separate signals (different signal names)", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const signals = analyzeSession(data);
		assert.strictEqual(
			signals.filter((s) => s.signal === "bash-grep").length,
			1,
			"bash-grep should be detected",
		);
		assert.strictEqual(
			signals.filter((s) => s.signal === "bash-cat").length,
			1,
			"bash-cat should also be detected (cat is a file read)",
		);
	});
});

// ── buildSessionAnalysis tests ──

describe("buildSessionAnalysis", () => {
	it("given SessionData + 1 signal → returns SessionAnalysis with correct fields", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0)]);
		const signals = [
			{
				signal: "redundant-read",
				label: "test",
				wastedTokens: 100,
				wastedCost: 0.001,
				occurrences: 1,
				details: [],
				context: {},
			},
		];
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).sessionId,
			"test-session",
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).timestamp,
			"",
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).totalWasteTokens,
			100,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).totalWasteCost,
			0.001,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).totalTokens,
			1000,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).totalCost,
			0.01,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).wasteFraction,
			0.1,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000, totalCost: 0.01 }).wasteBySignal
				.length,
			1,
		);
	});

	it("without metadata → falls back to totalWasteTokens * 3", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0)]);
		const signals = [
			{
				signal: "redundant-read",
				label: "test",
				wastedTokens: 100,
				wastedCost: 0.001,
				occurrences: 1,
				details: [],
				context: {},
			},
		];
		assert.strictEqual(buildSessionAnalysis(data, signals).totalTokens, 300);
		assert.strictEqual(buildSessionAnalysis(data, signals).totalCost, 0.003);
	});

	it("wasteFraction = totalWasteTokens / totalTokens", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0)]);
		const signals = [
			{
				signal: "redundant-read",
				label: "test",
				wastedTokens: 50,
				wastedCost: 0,
				occurrences: 1,
				details: [],
				context: {},
			},
			{
				signal: "bash-grep",
				label: "test",
				wastedTokens: 150,
				wastedCost: 0,
				occurrences: 1,
				details: [],
				context: {},
			},
		];
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000 }).totalWasteTokens,
			200,
		);
		assert.strictEqual(
			buildSessionAnalysis(data, signals, { totalTokens: 1000 }).wasteFraction,
			0.2,
		);
	});

	it("empty signals → totalWasteTokens=0, wasteFraction=0", () => {
		const data = makeSession([]);
		assert.strictEqual(buildSessionAnalysis(data, [], { totalTokens: 500 }).totalWasteTokens, 0);
		assert.strictEqual(buildSessionAnalysis(data, [], { totalTokens: 500 }).wasteFraction, 0);
	});

	it("totalTokens=0 → wasteFraction=0", () => {
		const data = makeSession([]);
		assert.strictEqual(buildSessionAnalysis(data, [], { totalTokens: 0 }).wasteFraction, 0);
	});
});
