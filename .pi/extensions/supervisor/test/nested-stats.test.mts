/**
 * Tests: session/nested-stats.ts — pure count/label/truncation policy.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/nested-stats.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNestedStats, formatNestedStats, combineErrorCount } from "../session/nested-stats.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── buildNestedStats ───────────────────────────────────────────

describe("buildNestedStats", () => {
	it("three ok calls, complete:true → all ok, no truncation", () => {
		const stats = buildNestedStats({
			nestedCalls: {
				calls: [
					{ name: "a", status: "ok" },
					{ name: "b", status: "ok" },
					{ name: "c", status: "ok" },
				],
				complete: true,
			},
		});
		assert.deepEqual(stats, {
			recorded: 3,
			ok: 3,
			err: 0,
			unfinished: 0,
			totalErrors: 0,
			truncated: false,
		});
	});

	it("three-valued calls keep unfinished out of err", () => {
		const stats = buildNestedStats({
			nestedCalls: {
				calls: [
					{ name: "a", status: "ok" },
					{ name: "b", status: "error" },
					{ name: "c", status: "unfinished" },
				],
				complete: true,
			},
		});
		assert.equal(stats.recorded, 3);
		assert.equal(stats.ok, 1);
		assert.equal(stats.err, 1);
		assert.equal(stats.unfinished, 1);
	});

	it("complete:false → truncated:true; complete:true and absent → false", () => {
		assert.equal(
			buildNestedStats({
				nestedCalls: { calls: [{ name: "a", status: "ok" }], complete: false },
			}).truncated,
			true,
		);
		assert.equal(
			buildNestedStats({
				nestedCalls: { calls: [{ name: "a", status: "ok" }], complete: true },
			}).truncated,
			false,
		);
	});

	it("nestedCalls absent → recorded:0 without throwing; calls:[] → recorded:0", () => {
		assert.equal(buildNestedStats(undefined).recorded, 0);
		assert.equal(buildNestedStats({}).recorded, 0);
		assert.equal(
			buildNestedStats({ nestedCalls: { calls: [], complete: true } }).recorded,
			0,
		);
	});

	it("dropped-error boundary: recorded list has no error, totalErrors carries the true count", () => {
		const calls = Array.from({ length: 30 }, (_v, i) => ({
			name: `t${i}`,
			status: "ok" as const,
		}));
		const stats = buildNestedStats({
			nestedCalls: { calls, complete: true },
			nestedErrorCount: 1,
		});
		assert.equal(stats.recorded, 30);
		assert.equal(stats.ok, 30);
		assert.equal(stats.err, 0);
		assert.equal(stats.totalErrors, 1);
	});

	it("nestedErrorCount undefined → totalErrors falls back to recorded errors", () => {
		assert.equal(buildNestedStats({}).totalErrors, 0);
		assert.equal(
			buildNestedStats({
				nestedCalls: { calls: [{ name: "a", status: "error" }], complete: true },
			}).totalErrors,
			1,
		);
	});
});

// ─── formatNestedStats ──────────────────────────────────────────

describe("formatNestedStats", () => {
	it("singular noun", () => {
		assert.equal(
			formatNestedStats({
				recorded: 1,
				ok: 1,
				err: 0,
				unfinished: 0,
				totalErrors: 0,
				truncated: false,
			}),
			"  nested: 1 call (1 ok, 0 err)",
		);
	});

	it("plural with errors", () => {
		assert.equal(
			formatNestedStats({
				recorded: 3,
				ok: 2,
				err: 1,
				unfinished: 0,
				totalErrors: 1,
				truncated: false,
			}),
			"  nested: 3 calls (2 ok, 1 err)",
		);
	});

	it("unfinished segment only when > 0", () => {
		assert.equal(
			formatNestedStats({
				recorded: 2,
				ok: 1,
				err: 0,
				unfinished: 1,
				totalErrors: 0,
				truncated: false,
			}),
			"  nested: 2 calls (1 ok, 0 err, 1 unfinished)",
		);
	});

	it("truncation suffix", () => {
		assert.equal(
			formatNestedStats({
				recorded: 1,
				ok: 1,
				err: 0,
				unfinished: 0,
				totalErrors: 0,
				truncated: true,
			}),
			"  nested: 1 call (1 ok, 0 err) (truncated)",
		);
	});

	it("recorded:0 → empty string", () => {
		assert.equal(
			formatNestedStats({
				recorded: 0,
				ok: 0,
				err: 0,
				unfinished: 0,
				totalErrors: 0,
				truncated: false,
			}),
			"",
		);
	});
});

// ─── combineErrorCount ──────────────────────────────────────────

describe("combineErrorCount", () => {
	it("both undefined → undefined", () => {
		assert.equal(combineErrorCount(undefined, undefined), undefined);
	});
	it("zero + undefined → 0", () => {
		assert.equal(combineErrorCount(0, undefined), 0);
	});
	it("adds both sources", () => {
		assert.equal(combineErrorCount(2, 3), 5);
	});
	it("nested only", () => {
		assert.equal(combineErrorCount(undefined, 2), 2);
	});
});

// ─── purity guard ───────────────────────────────────────────────

describe("nested-stats purity", () => {
	it("imports no TUI or host package", () => {
		const source = readFileSync(join(__dirname, "..", "session", "nested-stats.ts"), "utf8");
		assert.ok(!source.includes("@earendil-works/pi-tui"), "must not import pi-tui");
		assert.ok(!source.includes("@earendil-works/pi-coding-agent"), "must not import pi-coding-agent");
	});
});
