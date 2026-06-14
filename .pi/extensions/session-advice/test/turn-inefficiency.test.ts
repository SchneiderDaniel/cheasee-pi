/**
 * Tests for waste-signals/turn-inefficiency.ts — detectTurnInefficiency
 *
 * Largest test suite (~300 lines expected). Three phases matching #629 fixes:
 * - Bug 1: Novelty detection (incremental allReadFiles)
 * - Bug 2: Expanded discovery tools
 * - Bug 3: Threshold >=15 tool calls
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/turn-inefficiency.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectTurnInefficiency } from "../waste-signals/turn-inefficiency.ts";
import {
	makeSession,
	readEntry,
	writeEntry,
	ripgrepSearchEntry,
	structuralSearchEntry,
	webSearchEntry,
	webCrawlEntry,
	askUserEntry,
	nonDiscoveryBashEntry,
	nReadEntries,
} from "./session-test-helpers.ts";

/** Helper: extract turn-inefficiency signals from full result. */
function turnIneff(s: ReturnType<typeof detectTurnInefficiency>) {
	return s.filter((sig) => sig.signal === "turn-inefficiency");
}

// ── Phase 1: Novelty detection (Bug 1) ──

describe("detectTurnInefficiency — Phase 1: novelty detection (Bug 1)", () => {
	it("Turn 0 reads file A, Turn 2 has 15 reads of A + 1 read of novel file B → 0 signals", () => {
		const entries = [
			readEntry("/repo/fileA.ts", 0),
			...nReadEntries(15, "/repo/fileA.ts", 2),
			readEntry("/repo/fileB.ts", 2), // novel!
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"novel file read should prevent flagging",
		);
	});

	it("Turn 0 reads file A, Turn 2 has 15 reads of A only → 1 signal (no novelty)", () => {
		const entries = [readEntry("/repo/fileA.ts", 0), ...nReadEntries(15, "/repo/fileA.ts", 2)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			1,
			"no novel file → should flag",
		);
	});

	it("Turn 0 reads X,Y,Z, Turn 1 has 15 reads of X + 1 read of novel W → 0 signals", () => {
		const entries = [
			readEntry("/repo/X.ts", 0),
			readEntry("/repo/Y.ts", 0),
			readEntry("/repo/Z.ts", 0),
			...nReadEntries(15, "/repo/X.ts", 1),
			readEntry("/repo/W.ts", 1), // novel!
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"novel file W should prevent flagging",
		);
	});

	it("Old bug regression: W correctly counted as novel because allReadFiles builds incrementally", () => {
		const entries = [
			readEntry("/repo/X.ts", 0),
			readEntry("/repo/Y.ts", 0),
			readEntry("/repo/Z.ts", 0),
			...nReadEntries(15, "/repo/X.ts", 1),
			readEntry("/repo/W.ts", 1), // should be novel
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"W correctly counted as novel — old bug is fixed",
		);
	});

	it("Turn 0 reads file A, skip Turn 1, Turn 2 reads novel file B 15x → 0 signals (novel)", () => {
		const entries = [
			readEntry("/repo/fileA.ts", 0),
			...nReadEntries(15, "/repo/fileB.ts", 2), // novel!
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"file B never seen before → novel, no flag",
		);
	});
});

// ── Phase 2: Discovery tools (Bug 2) ──

describe("detectTurnInefficiency — Phase 2: discovery tools (Bug 2)", () => {
	it("14 reads + 1 ripgrep_search → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), ripgrepSearchEntry(0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"ripgrep_search is legitimate discovery",
		);
	});

	it("14 reads + 1 structural_search → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), structuralSearchEntry(0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"structural_search is legitimate discovery",
		);
	});

	it("14 reads + 1 web_search → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), webSearchEntry(0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"web_search is legitimate discovery",
		);
	});

	it("14 reads + 1 web_crawl → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), webCrawlEntry(0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"web_crawl is legitimate discovery",
		);
	});

	it("14 reads + 1 ask_user → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), askUserEntry(0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"ask_user is legitimate discovery",
		);
	});

	it("14 reads + 1 non-discovery bash (npm test) → 0 signals", () => {
		const entries = [...nReadEntries(14, "/repo/file.ts", 0), nonDiscoveryBashEntry("npm test", 0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"non-search bash is legitimate discovery",
		);
	});

	it("12 reads + ripgrep_search + structural_search → 0 signals", () => {
		const entries = [
			...nReadEntries(12, "/repo/file.ts", 0),
			ripgrepSearchEntry(0),
			structuralSearchEntry(0),
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"multiple discovery tools prevent flagging",
		);
	});
});

// ── Phase 3: Threshold (Bug 3) ──

describe("detectTurnInefficiency — Phase 3: threshold (Bug 3)", () => {
	it("14 tool calls, 0 file changes, 0 discovery → 0 signals (below threshold)", () => {
		const data = makeSession(nReadEntries(14, "/repo/file.ts", 0));
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"14 tool calls below threshold of 15",
		);
	});

	it("15 tool calls, 0 file changes, 0 discovery → 1 signal", () => {
		const entries = [readEntry("/repo/file.ts", 0), ...nReadEntries(15, "/repo/file.ts", 1)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			1,
			"15 tool calls with no discovery should flag",
		);
	});

	it("15 calls + novel file → 0 signals (discovery)", () => {
		const entries = [
			readEntry("/repo/fileA.ts", 0),
			...nReadEntries(15, "/repo/fileB.ts", 1), // novel!
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"novel file read is discovery, prevents flagging",
		);
	});

	it("30 calls + file change (write) → 0 signals", () => {
		const entries = [...nReadEntries(30, "/repo/file.ts", 0), writeEntry("/repo/file.ts", 0)];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"file change exempts turn",
		);
	});

	it("15 calls across 2 turns (8+7) → 0 signals (each turn below threshold)", () => {
		const entries = [
			...nReadEntries(8, "/repo/fileA.ts", 0),
			...nReadEntries(7, "/repo/fileB.ts", 1),
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"both turns below threshold",
		);
	});

	it("15 calls with both discovery bash + novel read → 0 signals", () => {
		const entries = [
			readEntry("/repo/known.ts", 0),
			...nReadEntries(13, "/repo/known.ts", 1),
			nonDiscoveryBashEntry("npm run build", 1),
			readEntry("/repo/novel.ts", 1), // novel!
		];
		const data = makeSession(entries);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"bash discovery + novel read prevents flagging",
		);
	});
});

// ── Legacy regression ──

describe("detectTurnInefficiency — legacy regression", () => {
	it("empty session → 0 signals, no crash", () => {
		assert.strictEqual(turnIneff(detectTurnInefficiency(makeSession([]))).length, 0);
	});

	it("1 entry → 0 signals", () => {
		const data = makeSession([readEntry("/src/file.ts", 0)]);
		assert.strictEqual(turnIneff(detectTurnInefficiency(data)).length, 0);
	});

	it("only file writes → 0 signals", () => {
		const data = makeSession([
			writeEntry("/repo/src/app.ts", 0),
			writeEntry("/repo/src/utils.ts", 0),
			writeEntry("/repo/src/main.ts", 0),
		]);
		assert.strictEqual(
			turnIneff(detectTurnInefficiency(data)).length,
			0,
			"file changes should exempt turn",
		);
	});

	it("signal has correct structure: signal, wastedTokens, context.turnRange", () => {
		const entries = [readEntry("/repo/file.ts", 0), ...nReadEntries(15, "/repo/file.ts", 1)];
		const data = makeSession(entries);
		assert.strictEqual(turnIneff(detectTurnInefficiency(data)).length, 1);
		assert.ok(
			turnIneff(detectTurnInefficiency(data))[0].wastedTokens > 0,
			"should have non-zero wasted tokens",
		);
		assert.ok(
			turnIneff(detectTurnInefficiency(data))[0].context.turnRange,
			"should have turnRange context",
		);
		assert.strictEqual(turnIneff(detectTurnInefficiency(data))[0].context.turnRange![0], 1);
		assert.strictEqual(turnIneff(detectTurnInefficiency(data))[0].context.turnRange![1], 1);
	});
});
