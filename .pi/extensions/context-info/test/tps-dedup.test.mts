/**
 * Tests for context-info TPS de-duplication (issue #2105).
 *
 * `formatting.ts` is the single owner of `computeTps`/`formatTps`. The
 * context-info test files borrow those implementations instead of declaring
 * byte-identical local copies (one of which had drifted to an anchor on the
 * last sample time instead of `Date.now()`).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/tps-dedup.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { computeTps, formatTps } from "../formatting.ts";
import type { TpsSample } from "../types.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── computeTps: production semantics (30s window anchored on Date.now()) ───

describe("computeTps — production window semantics", () => {
	it("empty buffer → null", () => {
		assert.strictEqual(computeTps([]), null);
	});

	it("single sample → null", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		assert.strictEqual(computeTps([{ time: 60_000, cumulativeTokens: 100 }]), null);
	});

	it("two samples with positive delta → tokens per second", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 58_000, cumulativeTokens: 0 },
			{ time: 60_000, cumulativeTokens: 100 },
		];
		// 100 tokens in 2s = 50 t/s
		assert.strictEqual(computeTps(samples), 50);
	});

	it("three samples over a 10s span → 10 t/s", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 50_000, cumulativeTokens: 0 },
			{ time: 55_000, cumulativeTokens: 50 },
			{ time: 60_000, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), 10);
	});

	it("samples outside the 30s window are excluded", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 0, cumulativeTokens: 0 }, // outside: cutoff is 30_000
			{ time: 35_000, cumulativeTokens: 100 },
			{ time: 60_000, cumulativeTokens: 400 },
		];
		// 300 tokens in 25s = 12 t/s
		assert.strictEqual(computeTps(samples), 12);
	});

	it("sample exactly at the 30s cutoff is included", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 30_000, cumulativeTokens: 0 }, // == cutoff (now - 30_000)
			{ time: 60_000, cumulativeTokens: 300 },
		];
		// 300 tokens in 30s = 10 t/s
		assert.strictEqual(computeTps(samples), 10);
	});

	it("zero token delta → null", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 50_000, cumulativeTokens: 100 },
			{ time: 60_000, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("non-increasing sample time (first.time > last.time) → null", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 60_000, cumulativeTokens: 0 },
			{ time: 55_000, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("window anchors on Date.now(), not on the last sample time (drift lock)", (t) => {
		// The deleted tps-estimator copy anchored its window on the last sample
		// time and returned 50 here. Production must prune both stale samples.
		t.mock.timers.enable({ apis: ["Date"], now: 60_000 });
		const samples: TpsSample[] = [
			{ time: 0, cumulativeTokens: 0 },
			{ time: 2_000, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});
});

// ─── formatTps: production formatting parity ────────────────────────────────

describe("formatTps — production formatting", () => {
	it("null → placeholder", () => {
		assert.strictEqual(formatTps(null), "-- t/s");
	});

	it("0 → one decimal", () => {
		assert.strictEqual(formatTps(0), "0.0 t/s");
	});

	it("0.09 → one decimal (very slow)", () => {
		assert.strictEqual(formatTps(0.09), "0.0 t/s");
	});

	it("42.5 → one decimal", () => {
		assert.strictEqual(formatTps(42.5), "42.5 t/s");
	});

	it("999.9 → one decimal", () => {
		assert.strictEqual(formatTps(999.9), "999.9 t/s");
	});

	it("1000 → rounded integer, no decimal", () => {
		assert.strictEqual(formatTps(1000), "1000 t/s");
	});
});

// ─── Guards: one owner, no local copies in the test layer ───────────────────

describe("TPS dedup guards", () => {
	const readSource = (relativePath: string): string =>
		readFileSync(join(here, relativePath), "utf-8");

	const countOccurrences = (source: string, needle: string): number =>
		source.split(needle).length - 1;

	it("formatting.ts exports exactly one computeTps and one formatTps", () => {
		const source = readSource("../formatting.ts");
		assert.strictEqual(countOccurrences(source, "export function computeTps"), 1);
		assert.strictEqual(countOccurrences(source, "export function formatTps"), 1);
	});

	// The guard file itself quotes these declaration strings, so it is not scanned.
	for (const file of [
		"context-status-bar.test.mts",
		"context-status-bar-part2.test.mts",
		"context-status-bar-part3.test.mts",
		"tps-estimator.test.mts",
	]) {
		it(`${file} declares no local computeTps/formatTps copy`, () => {
			const source = readSource(file);
			assert.strictEqual(countOccurrences(source, "function computeTps"), 0);
			assert.strictEqual(countOccurrences(source, "function formatTps"), 0);
		});
	}

	for (const file of ["context-status-bar-part2.test.mts", "tps-estimator.test.mts"]) {
		it(`${file} imports computeTps and formatTps from ../formatting.ts`, () => {
			const source = readSource(file);
			assert.ok(
				/import\s*\{[^}]*\bcomputeTps\b[^}]*\}\s*from\s*"\.\.\/formatting\.ts"/.test(source),
				`${file} must import computeTps from ../formatting.ts`,
			);
			assert.ok(
				/import\s*\{[^}]*\bformatTps\b[^}]*\}\s*from\s*"\.\.\/formatting\.ts"/.test(source),
				`${file} must import formatTps from ../formatting.ts`,
			);
		});
	}

	for (const file of ["context-status-bar.test.mts", "context-status-bar-part3.test.mts"]) {
		it(`${file} never referenced them, so it must not import them (no dead import)`, () => {
			const source = readSource(file);
			assert.strictEqual(countOccurrences(source, "computeTps"), 0);
			assert.strictEqual(countOccurrences(source, "formatTps"), 0);
		});
	}
});
