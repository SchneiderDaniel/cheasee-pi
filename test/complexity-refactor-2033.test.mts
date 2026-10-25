// ─── High-complexity-files refactor contract (issue #2033) ─────────
// CodeFlow's "N High Complexity Files" metric is
//   analyzed.filter(f => f.complexity.level === "critical")
// with `calcComplexity(content) = 1 + Σ(branch-regex hits)` over the RAW file
// text — comments and string literals included — and `critical ⇔ score > 30`.
// The detector literal has one owner: `test/fixtures/complexity-mirror.mts`
// (which re-exports `ANALYZER_REF`/`CODE_EXTS` from the long-file mirror).
//
// This is the in-gate oracle for the acceptance criterion:
//   (a) every family and every sibling it produced scores <= 30;
//   (b) nothing this change touched is still in the critical set;
//   (c) the tree-wide critical count may only fall — measured, never copied;
//   (d) every remaining flag is a recorded deferral with a `requires` pointer,
//       and every unscorable cited `.mts` path is recorded as such.
//
// The recorded envelope lives in `test/fixtures/complexity-baseline-2033.json`
// and is replayed by `test/codeflow-run-analysis.test.mts`.
//
// Run: node --experimental-strip-types --test test/complexity-refactor-2033.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ANALYZER_REF,
	CALC_PATTERNS,
	CEILING,
	CODE_EXTS,
	calcComplexity,
	measureComplexity,
} from "./fixtures/complexity-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const score = (rel: string): number => calcComplexity(read(rel)).score;
const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));

interface FamilyRecord {
	path: string;
	before: number;
	parts: number;
	seam: string;
	siblings: string[];
}

interface Baseline {
	provenance: {
		issue: number;
		filedAnalyzedAt: number;
		filedCount: number;
		ref: string;
		metric: string;
	};
	filedBaseline: { commit: string; files: number; codeFiles: number; criticalCount: number };
	before: { commit: string; files: number; codeFiles: number; criticalCount: number };
	after: { criticalCount: number; expectedDrop: number };
	partition: { scored: number; critical: number; notScored: number; belowCeiling: number };
	reducedBy: FamilyRecord[];
	deferred: Record<string, { reason: string; requires: string }>;
	notScored: string[];
	tradeoffs: Record<string, string>;
}

const baseline = JSON.parse(read("test/fixtures/complexity-baseline-2033.json")) as Baseline;

const ALL_TOUCHED = baseline.reducedBy.flatMap((f) => [f.path, ...f.siblings]);

// ─── Phase 1: the mirror mirrors the pinned detector ──────────────

describe("complexity refactor #2033 — the mirror is the pinned detector", () => {
	it("pins the 40-hex analyzer ref and all 24 regexes", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
		assert.equal(CALC_PATTERNS.length, 24, "9 JS + 10 Python + 5 Ruby patterns");
		assert.match(baseline.provenance.ref, /^[0-9a-f]{40}$/);
	});

	it("grades exactly at the pinned boundaries (critical ⇔ score > 30)", () => {
		const scored = (hits: number) => calcComplexity("if (".repeat(hits) + "x");
		assert.equal(scored(29).score, 30);
		assert.notEqual(scored(29).level, "critical", "30 is not critical");
		assert.equal(scored(30).score, 31);
		assert.equal(scored(30).level, "critical", "31 is critical");
		assert.equal(scored(9).level, "low");
		assert.equal(scored(10).level, "medium");
		assert.equal(scored(20).level, "high");
	});

	it("scores RAW text, so branch tokens inside comments count", () => {
		const noisy = "// " + "if (".repeat(31) + "\nconst x = 1;\n";
		assert.ok(calcComplexity(noisy).score > CEILING, "a .ts with 31 commented branch tokens flags");
		// …but only for scored extensions.
		const ext = (rel: string) => CODE_EXTS.includes(`.${rel.split(".").pop()}`);
		assert.equal(ext("src/example.ts"), true);
		for (const rel of ["src/example.mts", "src/example.json", "README.md"]) {
			assert.equal(ext(rel), false, `${rel} must stay unscored`);
		}
	});

	it("empty source scores 0 and is never critical", () => {
		assert.deepEqual(calcComplexity(""), { score: 0, level: "low" });
	});

	it("measures the tree as {files, codeFiles, flagged} with a sorted, unique flag set", () => {
		const m = measureComplexity(ROOT);
		assert.ok(m.files > m.codeFiles, "tracked files outnumber scored files");
		assert.ok(m.codeFiles > 0);
		assert.deepEqual(m.flagged, [...new Set(m.flagged)].sort(), "flags are sorted and unique");
	});

	it("the mirror is not a suite (never loaded as *.test.mts)", () => {
		assert.ok(!existsSync(resolve(ROOT, "test/fixtures/complexity-mirror.test.mts")));
	});
});

// ─── Phase 2: family invariants ───────────────────────────────────

describe("complexity refactor #2033 — the split families", () => {
	const measured = measureComplexity(ROOT);

	it("names the 12 documented families, each with siblings", () => {
		assert.equal(baseline.reducedBy.length, 12, "12 Wave-1 families");
		for (const family of baseline.reducedBy) {
			assert.ok(family.siblings.length >= 1, `${family.path} lists no sibling`);
			assert.ok(family.seam.length > 0, `${family.path} records no seam`);
		}
	});

	it("every family and sibling exists, is listed once, and is not a .mts", () => {
		for (const rel of ALL_TOUCHED) {
			assert.ok(exists(rel), `missing: ${rel}`);
			assert.ok(!rel.endsWith(".mts"), `${rel} is a .mts (unscorable)`);
		}
		assert.equal(new Set(ALL_TOUCHED).size, ALL_TOUCHED.length, "a file is listed twice");
	});

	for (const family of baseline.reducedBy) {
		it(`${family.path} and its siblings score <= ${CEILING}`, () => {
			for (const rel of [family.path, ...family.siblings]) {
				assert.ok(score(rel) <= CEILING, `${rel} scores ${score(rel)}`);
			}
		});

		it(`${family.path} budget is auditable: parts === 1 + siblings`, () => {
			assert.equal(family.parts, 1 + family.siblings.length);
			assert.ok(family.before > CEILING, `${family.path} was not over the ceiling`);
		});
	}

	it("no touched file remains in the measured critical set (no flag moved)", () => {
		const flagged = new Set(measured.flagged);
		for (const rel of ALL_TOUCHED) {
			assert.equal(flagged.has(rel), false, `${rel} is still critical`);
		}
	});

	it("no family or sibling uses a star re-export", () => {
		for (const rel of ALL_TOUCHED) {
			assert.equal(
				/export\s+\*\s+from/.test(read(rel)),
				false,
				`${rel} re-exports with export *`,
			);
		}
	});

	it("each family still exports its documented entry point", () => {
		const entryPoints: Record<string, string[]> = {
			".pi/skills/audit-codeflow-analysis/lib/fetch-report.ts": ["fetchAndStoreReport"],
			".pi/extensions/worktree-sandbox/unsafe-write.ts": ["findUnsafeWriteInBash"],
			".pi/extensions/agent-harness/agent-harness.ts": ["AgentHarness", "getBashSubKey"],
			".pi/extensions/supervisor/agent/task.ts": ["buildAgentTask"],
			".pi/extensions/supervisor/agent/output.ts": ["parseAgentOutput"],
			".pi/extensions/supervisor/agent/last-json-scanner.ts": ["extractLastJson"],
			".pi/extensions/supervisor/checks/osv-severity.ts": ["parseOsvJson", "cvss3BaseScore"],
			".pi/extensions/context-info/index.ts": ["contextInfo"],
			".pi/extensions/supervisor/pipeline/merge.ts": [
				"handlePostPipelineMerge",
				"ensurePrReadyForDone",
			],
			".pi/extensions/supervisor/agent/validation.ts": ["validateAgentOutput"],
			".pi/extensions/supervisor/github/git.ts": ["commitAndPush", "pushBranch", "commitChanges"],
			".pi/extensions/supervisor/event/adapter/handlers.ts": [
				"handleToolExecutionStart",
				"handleContextInfo",
			],
		};
		for (const [rel, names] of Object.entries(entryPoints)) {
			const src = read(rel);
			for (const name of names) {
				assert.ok(
					new RegExp(`\\b${name}\\b`).test(src),
					`${rel} no longer mentions ${name}`,
				);
			}
		}
	});
});

// ─── Phase 3: the recorded envelope ───────────────────────────────

describe("complexity refactor #2033 — the envelope only falls", () => {
	it("records the filed provenance (issue, analyzedAt, filed count, 40-hex ref)", () => {
		assert.equal(baseline.provenance.issue, 2033);
		assert.equal(baseline.provenance.filedCount, 286);
		assert.equal(baseline.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(baseline.provenance.ref, /^[0-9a-f]{40}$/);
		assert.match(baseline.provenance.metric, /critical/);
	});

	it("the filed baseline commit is a verified ancestor of the delivered tree", () => {
		assert.match(baseline.filedBaseline.commit, /^[0-9a-f]{40}$/);
		assert.doesNotThrow(() =>
			execFileSync("git", [
				"-C",
				ROOT,
				"merge-base",
				"--is-ancestor",
				baseline.filedBaseline.commit,
				"HEAD",
			]),
		);
		assert.deepEqual(
			{
				files: baseline.filedBaseline.files,
				codeFiles: baseline.filedBaseline.codeFiles,
				criticalCount: baseline.filedBaseline.criticalCount,
			},
			{ files: 1293, codeFiles: 732, criticalCount: 198 },
			"the architecture's e075a867 measurement",
		);
	});

	it("measures the delivered tree and holds the drop", () => {
		const measured = measureComplexity(ROOT);
		assert.equal(
			measured.flagged.length,
			baseline.after.criticalCount,
			"recorded after count drifted from the delivered tree",
		);
		assert.equal(
			measured.flagged.length,
			baseline.before.criticalCount - baseline.after.expectedDrop,
			"after must be before minus the reduced families",
		);
		assert.ok(measured.flagged.length < baseline.before.criticalCount, "monotone budget");
		assert.ok(
			measured.flagged.length <= baseline.filedBaseline.criticalCount,
			"never above the filed baseline",
		);
		assert.equal(measured.files, baseline.before.files, "the tree did not grow");
		assert.equal(measured.codeFiles, baseline.partition.scored);
	});

	it("every leftover flag is a recorded deferral, and nothing else is", () => {
		const measured = measureComplexity(ROOT);
		assert.deepEqual(
			[...measured.flagged].sort(),
			Object.keys(baseline.deferred).sort(),
			"the deferred set must equal the measured critical set",
		);
	});

	it("every deferral carries a reason and a requires pointer", () => {
		for (const [rel, entry] of Object.entries(baseline.deferred)) {
			assert.ok(exists(rel), `deferred path missing: ${rel}`);
			assert.ok(entry.reason.length > 0, `${rel} has no reason`);
			assert.ok(entry.requires.length > 0, `${rel} has no requires pointer`);
			assert.equal(
				baseline.reducedBy.some((f) => f.path === rel),
				false,
				`${rel} is both reduced and deferred`,
			);
		}
	});

	it("the unscorable cited .mts paths are recorded, not claimed as a reduction", () => {
		assert.ok(baseline.notScored.length > 0);
		assert.equal(baseline.partition.notScored, baseline.notScored.length);
		const deferred = new Set(Object.keys(baseline.deferred));
		const reduced = new Set(baseline.reducedBy.map((f) => f.path));
		for (const rel of baseline.notScored) {
			assert.ok(rel.endsWith(".mts"), `${rel} is not a .mts`);
			assert.ok(exists(rel), `notScored path missing: ${rel}`);
			assert.equal(CODE_EXTS.includes(".mts"), false, ".mts is never scored");
			assert.equal(deferred.has(rel), false, `${rel} is both deferred and notScored`);
			assert.equal(reduced.has(rel), false, `${rel} is both reduced and notScored`);
		}
		assert.equal(new Set(baseline.notScored).size, baseline.notScored.length);
	});

	it("reducedBy covers every family, and every path exists", () => {
		for (const family of baseline.reducedBy) {
			assert.ok(exists(family.path), `missing family: ${family.path}`);
			assert.ok(!family.path.endsWith(".mts"));
		}
		assert.equal(Object.keys(baseline.tradeoffs).length > 0, true, "trade-offs are recorded");
	});

	it("the #2003 suite consumes the shared mirror instead of inlining a detector", () => {
		const src = read("test/complexity-refactor-2003.test.mts");
		assert.match(src, /from "\.\/fixtures\/complexity-mirror\.mts"/);
		assert.equal(/const PATTERNS\s*=/.test(src), false, "the detector literal moved out");
		assert.equal(/\\bif\\s\*\\\(/.test(src), false, "no inline branch regex");
	});
});
