// ─── Long-file split oracle (issue #2099) ─────────────────────────
// CodeFlow's "Long File" anti-pattern flags every analyzed file whose raw
// newline-segment count exceeds 500:
//   longFiles = analyzed.filter(f => f.isCode !== false && f.lines && f.lines > 500)
//   lines = content.split("\n").length
// This issue cited five files. Three supervisor test suites remain split into
// cohesive `<stem>-<concern>.test.mts` siblings; the Octokit suite was replaced
// by focused adapter suites under #2098. The fifth (`codeflow/fp-filter.js`)
// was already split under #2100 and is out of scope.
//
// The detector is *not* re-derived here: `lineCount`/`isFlagged` come from
// `test/fixtures/long-file-mirror.mts`, the single owner of the pinned
// analyzer semantics (`ANALYZER_REF`). Re-deriving the literal in a second
// place is how a mirror silently drifts from the analyzer it mirrors.
//
// Siblings are discovered dynamically by stem prefix, so a part file that a
// later split forgets to land under the ceiling fails here instead of escaping
// the oracle. Files are read with `readFileSync`, never `measureWorktree()` —
// the latter enumerates `git ls-files` and would miss untracked new files, i.e.
// it would pass before `git add`.
//
// Run: node --experimental-strip-types --test test/long-file-split-2099.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isFlagged, lineCount } from "./fixtures/long-file-mirror.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The repo-wide ceiling every split family must land under. */
const CEILING = 500;

const SUP_TEST = ".pi/extensions/supervisor/test";

interface Family {
	/** Stable family id, used in subtest names. */
	name: string;
	/** Directory holding the original and its siblings (repo-relative). */
	dir: string;
	/** Filename stem siblings share, e.g. `gh-client` → `gh-client-token.test.mts`. */
	stem: string;
	/** The suite as cited by the issue. */
	original: string;
	/** Siblings the split must mint, discovered dynamically and compared to this. */
	siblings: string[];
}

/**
 * The three still-independent suites split by this issue. #2098 replaced the
 * OctokitClient test family with adapter suites, which are pinned separately
 * below. `codeflow/fp-filter.js` is deliberately absent: #2100 already split
 * it, and the index is pinned separately as the documented out-of-scope file.
 */
const FAMILIES: Family[] = [
	{
		name: "developer-pr",
		dir: `${SUP_TEST}/pipeline`,
		stem: "developer-pr",
		original: `${SUP_TEST}/pipeline/developer-pr.test.mts`,
		siblings: ["developer-pr-upsert.test.mts", "developer-pr-wiring.test.mts"],
	},
	{
		name: "gh-client",
		dir: `${SUP_TEST}/github`,
		stem: "gh-client",
		original: `${SUP_TEST}/github/gh-client.test.mts`,
		siblings: ["gh-client-token.test.mts"],
	},
	{
		name: "validation",
		dir: SUP_TEST,
		stem: "validation",
		original: `${SUP_TEST}/validation.test.mts`,
		siblings: ["validation-golden-matrix.test.mts", "validation-structure.test.mts"],
	},
];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const segmentsOf = (rel: string): number => lineCount(read(rel));

/** Suite files beside `family.original` that share its stem. */
function discoveredSiblings(family: Family): string[] {
	const absDir = resolve(ROOT, family.dir);
	assert.ok(existsSync(absDir), `missing family directory: ${family.dir}`);
	return readdirSync(absDir)
		.filter((n) => n.startsWith(`${family.stem}-`) && n.endsWith(".test.mts"))
		.sort();
}

describe("long-file split #2099 — the ceiling is the pinned detector's", () => {
	it("has teeth at the exact boundary (strictly more than 500 segments)", () => {
		const mk = (n: number): string => "x\n".repeat(n - 1) + "x";
		assert.equal(lineCount(mk(500)), 500, "500 segments is 500 by the analyzer's own count");
		assert.equal(isFlagged(mk(500), "sample.ts"), false, "500 segments must not be flagged");
		assert.equal(isFlagged(mk(501), "sample.ts"), true, "501 segments must be flagged");
	});

	it("counts a trailing newline — 500 lines is 501 segments", () => {
		assert.equal(lineCount("export const x = 1;\n".repeat(500)), 501);
	});

	it("does not score .mts, but the repo ceiling still binds these suites", () => {
		// The analyzer's codeExts gate is why this issue is only a convention
		// matter for `.mts` — the #2035 ledger applies the same 500-segment
		// ceiling to the suites anyway, so a split must respect it.
		assert.equal(isFlagged("x;\n".repeat(600), "sample.mts"), false, ".mts is unscored");
		assert.equal(lineCount("x;\n".repeat(600)) > CEILING, true, "yet it is still over 500");
	});
});

describe("long-file split #2099 — the four cited suites and their siblings", () => {
	it("the pinned coverage inventory stays under the ceiling too", () => {
		// The fixture is `.json`, so the analyzer never scores it — but the split
		// must not mint its own long file while clearing the others.
		const rel = "test/fixtures/test-split-inventory-2099.json";
		assert.ok(existsSync(resolve(ROOT, rel)), `missing: ${rel}`);
		const segments = segmentsOf(rel);
		assert.ok(segments <= CEILING, `${rel} counts ${segments} segments (ceiling ${CEILING})`);
	});

	for (const family of FAMILIES) {
		it(`${family.name}: siblings beside the original are exactly the split parts`, () => {
			assert.ok(existsSync(resolve(ROOT, family.original)), `missing: ${family.original}`);
			assert.deepEqual(
				discoveredSiblings(family),
				[...family.siblings].sort(),
				`${family.name} siblings drifted — a part file was added or forgotten`,
			);
		});

		it(`${family.name}: original and every sibling count <= ${CEILING} segments`, () => {
			for (const rel of [family.original, ...family.siblings.map((s) => `${family.dir}/${s}`)]) {
				assert.ok(existsSync(resolve(ROOT, rel)), `missing: ${rel}`);
				const segments = segmentsOf(rel);
				assert.ok(segments <= CEILING, `${rel} counts ${segments} segments (ceiling ${CEILING})`);
			}
		});
	}

	it("the #2098 Octokit replacement suites stay under the shared ceiling", () => {
		for (const rel of [
			`${SUP_TEST}/github/octokit-issues.test.mts`,
			`${SUP_TEST}/github/octokit-pulls.test.mts`,
			`${SUP_TEST}/github/octokit-projects.test.mts`,
		]) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing: ${rel}`);
			const segments = segmentsOf(rel);
			assert.ok(segments <= CEILING, `${rel} counts ${segments} segments (ceiling ${CEILING})`);
		}
	});
});

describe("long-file split #2099 — the fifth cited file is out of scope", () => {
	const FP_FILTER = "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js";

	it("fp-filter.js was already split under #2100 and stays under the ceiling", () => {
		assert.ok(existsSync(resolve(ROOT, FP_FILTER)), `missing: ${FP_FILTER}`);
		const segments = segmentsOf(FP_FILTER);
		assert.ok(segments <= CEILING, `${FP_FILTER} counts ${segments} segments`);
		assert.equal(
			segments,
			463,
			`${FP_FILTER} moved to ${segments} segments — the out-of-scope measurement recorded by #2099` +
				" is stale; re-measure and, if it crossed the ceiling, split it per the #2100 module layout",
		);
	});
});
