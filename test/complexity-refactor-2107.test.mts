// ─── High-complexity-files envelope (issue #2107) ───────────────────
// CodeFlow's "N High Complexity Files" metric is
//   analyzed.filter(f => f.complexity.level === "critical")
// with `calcComplexity(content) = 1 + Σ(branch-regex hits)` over the RAW file
// text — comments and string literals included — and `critical ⇔ score > 30`.
// The detector literal has one owner: `test/fixtures/complexity-mirror.mts`.
//
// This is the in-gate oracle for the 5 files issue #2107 cites. The finding is
// a 5-file sample of a 315-file count, so the deliverable is NOT "no cited file
// is critical": it is that every cited file has a measured verdict.
//   (a) two files were refactored in place and measure strictly lower;
//   (b) one does not apply (linear bootstrap) and measures unchanged;
//   (c) two are `.mts` and are therefore never scored — recorded, not claimed;
//   (d) no flag moved: both refactored files stay above the ceiling and stay
//       deferred in the #2033 envelope, which this change must not invalidate;
//   (e) no scored file was added by this PR, so `codeFiles` stays at the 871-file branch-base count.
//
// The recorded envelope lives in `test/fixtures/complexity-baseline-2107.json`.
//
// Run: node --experimental-strip-types --test test/complexity-refactor-2107.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ANALYZER_REF,
	CEILING,
	CODE_EXTS,
	calcComplexity,
	measureComplexity,
} from "./fixtures/complexity-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));

interface CitedFile {
	path: string;
	citedAs: string;
	lines: number;
	before: number | null;
	after: number | null;
	verdict: "reduced" | "unchanged" | "not-scored";
	finding: string;
	change: string;
	evidence: string;
}

interface Baseline {
	provenance: {
		issue: number;
		title: string;
		kind: string;
		disposition: string;
		analyzedAt: string;
		filedCount: number;
		ref: string;
		oracle: string;
		metric: string;
	};
	base: { commit: string; files: number; codeFiles: number; criticalCount: number };
	cited: CitedFile[];
	deferred: Record<string, { reason: string; requires: string }>;
	controls: { codeFiles: number; criticalCount: number };
}

const baseline = JSON.parse(read("test/fixtures/complexity-baseline-2107.json")) as Baseline;

/** The #2033 envelope, which owns the tree-wide flag set this change must keep. */
const envelope2033 = JSON.parse(read("test/fixtures/complexity-baseline-2033.json")) as {
	after: { criticalCount: number };
	deferred: Record<string, { reason: string; requires: string }>;
};

const SCORED_CITED = baseline.cited.filter((f) => f.verdict !== "not-scored");
const REDUCED = baseline.cited.filter((f) => f.verdict === "reduced");
const UNCHANGED = baseline.cited.filter((f) => f.verdict === "unchanged");
const NOT_SCORED = baseline.cited.filter((f) => f.verdict === "not-scored");

// ─── Phase 1: the finding and the measurement it rests on ─────────

describe("complexity refactor #2107 — the filed finding", () => {
	it("records the CodeFlow signal it answers", () => {
		assert.equal(baseline.provenance.issue, 2107);
		assert.equal(baseline.provenance.filedCount, 315, "the filed count");
		assert.equal(baseline.provenance.kind, "architecture");
		assert.equal(baseline.provenance.disposition, "file-refactor");
		assert.match(baseline.provenance.ref, /^[0-9a-f]{40}$/, "the pinned analyzer ref");
		assert.equal(baseline.provenance.ref, ANALYZER_REF, "one analyzer pin, not two");
		assert.match(baseline.provenance.metric, /level === "critical"/);
		assert.match(baseline.provenance.metric, /> 30/, "the metric names the ceiling");
	});

	it("cites exactly the five files the finding names", () => {
		assert.equal(baseline.cited.length, 5);
		assert.deepEqual(
			baseline.cited.map((f) => f.citedAs).sort(),
			[
				"agent-comment.ts",
				"codeflow-fp-filter.test.mts",
				"entrypoint.sh",
				"fp-filter.js",
				"git-issue-create-external-skill.test.mts",
			],
			"the filed bare names",
		);
	});

	it("resolves every cited name to one existing tracked path", () => {
		for (const file of baseline.cited) {
			assert.ok(exists(file.path), `missing cited path: ${file.path}`);
			assert.ok(file.path.endsWith(file.citedAs), `${file.path} does not end in ${file.citedAs}`);
			assert.ok(file.finding.length > 0, `${file.path} states no verdict`);
			assert.ok(file.evidence.length > 0, `${file.path} states no evidence`);
		}
		assert.equal(new Set(baseline.cited.map((f) => f.path)).size, 5, "a path is cited twice");
	});

	it("records the branch base this envelope is measured against", () => {
		assert.match(baseline.base.commit, /^[0-9a-f]{40}$/);
		assert.deepEqual(
			{
				files: baseline.base.files,
				codeFiles: baseline.base.codeFiles,
				criticalCount: baseline.base.criticalCount,
			},
			{ files: 1635, codeFiles: 871, criticalCount: 190 },
			"the measurement at the branch base",
		);
	});
});

// ─── Phase 2: every cited file has a measured verdict ─────────────

describe("complexity refactor #2107 — the cited files", () => {
	it("scores every scorable cited file at the recorded value, measured live", () => {
		for (const file of SCORED_CITED) {
			assert.equal(typeof file.before, "number", `${file.path} records no before score`);
			assert.equal(typeof file.after, "number", `${file.path} records no after score`);
			assert.equal(
				calcComplexity(read(file.path)).score,
				file.after,
				`${file.path} drifted from its recorded score`,
			);
		}
	});

	it("never regresses a cited file", () => {
		for (const file of SCORED_CITED) {
			assert.ok(
				(file.after as number) <= (file.before as number),
				`${file.path} got worse: ${file.before} → ${file.after}`,
			);
		}
	});

	it("proves each refactored file measurably improved", () => {
		assert.ok(REDUCED.length >= 2, "at least the two real hotspots were refactored");
		for (const file of REDUCED) {
			assert.ok(
				(file.after as number) < (file.before as number),
				`${file.path} claims a reduction but measures ${file.before} → ${file.after}`,
			);
			assert.ok(file.change.length > 0, `${file.path} lists no change`);
			assert.ok(!file.path.endsWith(".mts"), `${file.path} is a .mts (unscorable)`);
		}
	});

	it("states why the unchanged file needs no change", () => {
		assert.equal(UNCHANGED.length, 1);
		for (const file of UNCHANGED) {
			assert.equal(file.after, file.before, `${file.path} claims unchanged but moved`);
			assert.ok(/does not apply/.test(file.finding), `${file.path} gives no reason`);
		}
		assert.equal(UNCHANGED[0].path, "cmd/cheasee-pi/embedded/docker/entrypoint.sh");
	});

	it("records the unscorable cited .mts paths as such, not as a reduction", () => {
		assert.equal(NOT_SCORED.length, 2);
		for (const file of NOT_SCORED) {
			assert.ok(file.path.endsWith(".mts"), `${file.path} is not a .mts`);
			assert.equal(CODE_EXTS.includes(".mts"), false, ".mts is never scored");
			assert.equal(file.before, null);
			assert.equal(file.after, null);
		}
		assert.equal(new Set(NOT_SCORED.map((f) => f.path)).size, 2, "a path is listed twice");
	});
});

// ─── Phase 3: the envelope holds the tree-wide invariants ────────

describe("complexity refactor #2107 — no flag moved", () => {
	it("adds no scored file, so `codeFiles` is unchanged", () => {
		const measured = measureComplexity(ROOT);
		assert.ok(
			measured.codeFiles === baseline.controls.codeFiles,
			"the PR must not add a scored file beyond its recorded branch base",
		);
		assert.ok(measured.files >= baseline.base.files, "the tracked tree never shrinks");
		// An untracked sibling would not reach `git ls-files` yet, so check the
		// directory itself: the policy stays one served script.
		const siblings = readdirSync(resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow")).filter(
			(name) => /^fp-filter.*\.js$/.test(name),
		);
		assert.deepEqual(siblings, ["fp-filter.js"], "fp-filter.js was split into siblings");
	});

	it("leaves the tree-wide critical set exactly where #2033 recorded it", () => {
		const measured = measureComplexity(ROOT);
		assert.equal(
			measured.flagged.length,
			baseline.controls.criticalCount,
			"an in-place reduction must not drop a file out of the critical set",
		);
		assert.equal(
			measured.flagged.length,
			envelope2033.after.criticalCount,
			"the #2033 envelope must still describe the delivered tree",
		);
		assert.deepEqual(
			measured.flagged,
			Object.keys(envelope2033.deferred).sort(),
			"every measured flag is still a recorded #2033 deferral",
		);
	});

	it("keeps each deferred file above the ceiling and deferred in #2033", () => {
		for (const file of REDUCED) {
			const score = calcComplexity(read(file.path)).score;
			const deferred2033 = file.path in envelope2033.deferred;
			if (score > CEILING) {
				assert.equal(deferred2033, true, `${file.path} is still critical but undeferred in #2033`);
				continue;
			}
			assert.equal(
				deferred2033,
				false,
				`${file.path} sank below ${CEILING} — refresh the #2033 envelope instead of leaving it stale`,
			);
		}
	});

	it("carries a reason and a requires pointer for every file still deferred", () => {
		const files = Object.keys(baseline.deferred);
		assert.deepEqual(
			files.sort(),
			REDUCED.map((f) => f.path).sort(),
			"every reduced file that stays critical is deferred, and nothing else",
		);
		for (const [path, entry] of Object.entries(baseline.deferred)) {
			assert.ok(exists(path), `deferred path missing: ${path}`);
			assert.ok(entry.reason.length > 0, `${path} states no reason`);
			assert.ok(entry.requires.length > 0, `${path} states no requires pointer`);
		}
	});

	it("puts the split of fp-filter.js behind its four consumers", () => {
		const entry = baseline.deferred["cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js"];
		assert.ok(entry, "the fp-filter deferral is recorded");
		for (const consumer of [
			"run-analysis.mjs",
			"ui_rewrites.py",
			"embed",
			"COPY",
			"codeflow_shim_fp_filter_test.go",
		]) {
			assert.match(
				entry.requires,
				new RegExp(consumer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				`the deferral must name the ${consumer} consumer it waits on`,
			);
		}
	});

	it("is not itself a suite the analyzer scores", () => {
		assert.ok(!CODE_EXTS.includes(".mts"));
		assert.ok(!exists("test/complexity-refactor-2107.test.js"));
	});
});
