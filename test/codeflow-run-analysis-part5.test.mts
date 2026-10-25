import assert from "node:assert";

import { existsSync, readFileSync } from "node:fs";

import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { measureComplexity } from "./fixtures/complexity-mirror.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── High-complexity-files oracle (issue #2033) ─────────────────────
// Same shape as the #2005 block: the pinned analyzer run needs the CodeFlow
// checkout and a `git archive` of two commits, so the measurement stays out of
// this in-gate suite (the mirror that enforces the `<= 30` per-sibling
// invariant lives in `test/complexity-refactor-2033.test.mts`). This block
// replays the recorded before/after and guards the record's shape.
const COMPLEXITY_2033 = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "complexity-baseline-2033.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	filedBaseline: { commit: string; files: number; codeFiles: number; criticalCount: number };
	before: { commit: string; files: number; codeFiles: number; criticalCount: number };
	after: { criticalCount: number; expectedDrop: number };
	partition: { scored: number; critical: number; notScored: number; belowCeiling: number };
	reducedBy: Array<{ path: string; before: number; parts: number; siblings: string[] }>;
	deferred: Record<string, { reason: string; requires: string }>;
	notScored: string[];
};

describe("complexity metric oracle (issue #2033)", () => {
	it("records a real drop between two measured trees on the pinned analyzer", () => {
		assert.strictEqual(COMPLEXITY_2033.provenance.issue, 2033);
		assert.strictEqual(
			COMPLEXITY_2033.provenance.filedCount,
			286,
			"the issue's filed count is a superset, not the analyzer's flag set",
		);
		assert.strictEqual(COMPLEXITY_2033.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(COMPLEXITY_2033.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			COMPLEXITY_2033.provenance.metric,
			/level === "critical"/,
			"the metric names the critical predicate",
		);
		assert.match(COMPLEXITY_2033.provenance.metric, /> 30/, "the metric names the ceiling");
		for (const [side, ref] of [
			["filedBaseline", COMPLEXITY_2033.filedBaseline],
			["before", COMPLEXITY_2033.before],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			COMPLEXITY_2033.before.commit,
			COMPLEXITY_2033.filedBaseline.commit,
			"the branch base advanced past the filed baseline; both are recorded",
		);
		assert.strictEqual(
			COMPLEXITY_2033.after.criticalCount,
			COMPLEXITY_2033.before.criticalCount - COMPLEXITY_2033.after.expectedDrop,
			"after is before minus the reduced families",
		);
		assert.ok(
			COMPLEXITY_2033.after.criticalCount < COMPLEXITY_2033.before.criticalCount,
			"the flagged-file count must fall",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.strictEqual(COMPLEXITY_2033.reducedBy.length, 12, "the 12 Wave-1 families");
		for (const family of COMPLEXITY_2033.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", family.path)), `missing: ${family.path}`);
			assert.ok(!family.path.endsWith(".mts"), `${family.path} is test-only (never scored)`);
			assert.strictEqual(family.parts, 1 + family.siblings.length);
			for (const rel of family.siblings) {
				assert.ok(existsSync(resolve(HERE, "..", rel)), `missing sibling: ${rel}`);
			}
		}
	});

	it("defers every leftover flag with a requires pointer, never omitting one", () => {
		const deferred = Object.entries(COMPLEXITY_2033.deferred);
		assert.strictEqual(
			deferred.length,
			COMPLEXITY_2033.after.criticalCount,
			"the deferral list is exactly the remaining flag set",
		);
		for (const [rel, entry] of deferred) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(entry.reason.length > 0, `${rel} states no reason`);
			assert.ok(entry.requires.length > 0, `${rel} states no requires pointer`);
		}
		const rust = deferred.filter(([rel]) => rel.endsWith(".rs"));
		assert.ok(rust.length >= 8, "the Rust UI set is recorded as deferred");
		assert.ok(
			rust.every(([, e]) => /Rust toolchain/.test(e.requires)),
			"the Rust deferral names the missing toolchain",
		);
	});

	it("records the unscorable .mts paths as such", () => {
		assert.strictEqual(COMPLEXITY_2033.notScored.length, COMPLEXITY_2033.partition.notScored);
		assert.ok(COMPLEXITY_2033.notScored.length > 0);
		for (const rel of COMPLEXITY_2033.notScored) {
			assert.ok(rel.endsWith(".mts"), `${rel} is not a .mts`);
			assert.strictEqual(
				rel in COMPLEXITY_2033.deferred,
				false,
				`${rel} is both notScored and deferred`,
			);
		}
	});

	it("names the record and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/complexity-refactor-2033.test.mts",
			".pi/skills/audit-codeflow-analysis/references/complexity-2033.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});

	it("ties the recorded after envelope to the delivered tree", () => {
		// Recompute the pinned predicate over the delivered tree with the same mirror
		// the per-family oracle uses, so the recorded count and the deferral list
		// cannot drift from the source they describe.
		const measured = measureComplexity(resolve(HERE, ".."));
		assert.strictEqual(
			measured.flagged.length,
			COMPLEXITY_2033.after.criticalCount,
			"the recorded after count must equal the measured flag count",
		);
		assert.deepStrictEqual(
			measured.flagged,
			Object.keys(COMPLEXITY_2033.deferred).sort(),
			"every measured flag must be a recorded deferral",
		);
		assert.ok(
			measured.flagged.length < COMPLEXITY_2033.before.criticalCount,
			"the delivered tree carries fewer flags than the branch base",
		);
	});
});
