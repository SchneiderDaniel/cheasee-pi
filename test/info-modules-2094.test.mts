// ─── Informational "Modules" pattern (issue #2094) ──────────────────────────
// CodeFlow raised the informational `Modules` pattern (kind: `pattern`,
// disposition: `offer-optional`) over five paths. They share only the word
// "module"; the label groups three unrelated concerns:
//
//   1. `scripts/check-no-submodules.sh` — the single-normal-repo invariant
//      guard from #1492. It is build tooling, not a codebase module.
//   2. `.pi/extensions/supervisor/test/requirements-modules*.test.mts` — suites
//      named after the split `checks/requirements/` modules they cover.
//   3. `.pi/skills/audit-codeflow-analysis/references/vba-god-module-*.md` —
//      records of measured `VBA God Module` reductions.
//
// The architecture verdict is "no change": the analyzer's god-module predicate
// (`functions.length > 20` per file) is nowhere near hit by the named modules
// (max 3 declarations), the submodule guard is an intentional invariant, and the
// two markdown files are measurement records, not code. This file pins that
// verdict so a re-signal cannot silently drift:
//
//   Phase 1 — every cited path resolves at the architecture-corrected location
//             and is tracked by git (the Researcher's "no match" hint was wrong;
//             the paths are real, just deeper than the report said).
//   Phase 2 — the submodule guard is green *and* non-vacuous: it must reject a
//             `.gitmodules` fixture, and the Makefile must keep invoking it.
//   Phase 3 — the "Modules" label originates from the split check modules, which
//             are under the ceiling and each imported by one of the two suites;
//             there is no god module behind the signal.
//   Phase 4 — each reduction record still agrees with its recorded fixture.
//
// Deliberately not pinned: `git status --porcelain` touching only this file (the
// pipeline commits before audit, and unrelated worktree changes would make that
// assertion fail for the wrong reason), and the duplicate run-command line in the
// `requirements-modules-part2` header (the architecture flags it as an optional
// doc nit, explicitly out of scope for this no-op issue).
//
// Run: node --experimental-strip-types --test test/info-modules-2094.test.mts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The five paths the #2094 report cites, at their verified locations. */
const CITED = [
	"scripts/check-no-submodules.sh",
	".pi/extensions/supervisor/test/requirements-modules.test.mts",
	".pi/extensions/supervisor/test/requirements-modules-part2.test.mts",
	".pi/skills/audit-codeflow-analysis/references/vba-god-module-2006.md",
	".pi/skills/audit-codeflow-analysis/references/vba-god-module-2036.md",
];

const GUARD = resolve(ROOT, "scripts/check-no-submodules.sh");
const MAKEFILE = resolve(ROOT, "Makefile");
const REQUIREMENTS_DIR = resolve(ROOT, ".pi/extensions/supervisor/checks/requirements");
const SUPERVISOR_TEST_DIR = resolve(ROOT, ".pi/extensions/supervisor/test");
const REFERENCES_DIR = resolve(ROOT, ".pi/skills/audit-codeflow-analysis/references");

const REQUIREMENTS_SUITES = [
	"requirements-modules.test.mts",
	"requirements-modules-part2.test.mts",
];

/** Orchestrator: its contract is asserted by the suites' orchestration tests. */
const ORCHESTRATOR_MODULE = "index.ts";
/** Type-only module: imports and exports carry no runtime declaration. */
const TYPE_ONLY_MODULE = "types.ts";

/**
 * The analyzer's `VBA God Module` predicate is `functions.length > 20` on a raw
 * text function count, so a file at 21 declarations or more is what the label
 * would point at. Nothing here is remotely close.
 */
const GOD_MODULE_CEILING = 20;
const FUNCTION_DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$]/gm;

/** Collapse markdown wrapping so prose claims can be matched literally. */
function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function read(relPath: string): string {
	return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("Phase 1 — cited artifacts resolve and are tracked", () => {
	for (const relPath of CITED) {
		it(`exists: ${relPath}`, () => {
			assert.ok(existsSync(resolve(ROOT, relPath)), `cited path does not exist: ${relPath}`);
		});

		it(`is tracked by git: ${relPath}`, () => {
			const res = spawnSync("git", ["ls-files", "--error-unmatch", relPath], {
				cwd: ROOT,
				encoding: "utf8",
			});
			assert.equal(
				res.status,
				0,
				`cited path is not tracked by git: ${relPath}\n${res.stdout}${res.stderr}`,
			);
		});
	}
});

describe("Phase 2 — the submodule invariant guard is green and non-vacuous", () => {
	it("passes on this worktree", () => {
		const res = spawnSync("bash", [GUARD], { cwd: ROOT, encoding: "utf8" });
		assert.equal(res.status, 0, `guard failed on this worktree:\n${res.stdout}${res.stderr}`);
		assert.match(res.stdout, /check-no-submodules: OK/, "guard no longer reports OK");
	});

	it("rejects a .gitmodules fixture outside the worktree", () => {
		const fixture = mkdtempSync(join(tmpdir(), "info-modules-2094-"));
		try {
			const init = spawnSync("git", ["init", "-q"], { cwd: fixture, encoding: "utf8" });
			assert.equal(init.status, 0, `git init failed in fixture:\n${init.stderr}`);
			writeFileSync(
				join(fixture, ".gitmodules"),
				'[submodule "probe"]\n\tpath = probe\n\turl = https://example.com/probe.git\n',
			);

			const res = spawnSync("bash", [GUARD], { cwd: fixture, encoding: "utf8" });
			assert.notEqual(
				res.status,
				0,
				`guard accepted a .gitmodules fixture — it is vacuous:\n${res.stdout}`,
			);
			assert.match(
				res.stderr,
				/\.gitmodules exists/,
				`guard failed for the wrong reason:\n${res.stderr}`,
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("stays wired into the Makefile (#1492)", () => {
		const makefile = readFileSync(MAKEFILE, "utf8");
		assert.match(
			makefile,
			/^check-no-submodules:/m,
			"Makefile lost the `check-no-submodules` target — the invariant is unwired",
		);
		assert.match(
			makefile,
			/^[ \t]+@?bash scripts\/check-no-submodules\.sh$/m,
			"Makefile target no longer invokes `bash scripts/check-no-submodules.sh`",
		);
	});
});

describe("Phase 3 — the label names the split check modules, not a god module", () => {
	it("keeps every check module under the god-module ceiling", () => {
		const modules = readdirSync(REQUIREMENTS_DIR).filter((file) => file.endsWith(".ts"));
		assert.ok(
			modules.length > 0,
			`no modules found under .pi/extensions/supervisor/checks/requirements/`,
		);

		for (const module of modules) {
			const source = readFileSync(join(REQUIREMENTS_DIR, module), "utf8");
			const declarations = [...source.matchAll(FUNCTION_DECL)].length;
			assert.ok(
				declarations <= GOD_MODULE_CEILING,
				`${module} declares ${declarations} top-level functions — ` +
					`at or above the analyzer's god-module ceiling (${GOD_MODULE_CEILING}), ` +
					`so the "Modules" label could originate here`,
			);
		}
	});

	it("imports every runtime module from one of the two suites", () => {
		const imported = new Set<string>();
		for (const suite of REQUIREMENTS_SUITES) {
			const source = readFileSync(join(SUPERVISOR_TEST_DIR, suite), "utf8");
			for (const match of source.matchAll(
				/from\s+"[^"]*checks\/requirements\/([A-Za-z0-9_]+)\.ts"/g,
			)) {
				imported.add(`${match[1]}.ts`);
			}
		}

		const covered = readdirSync(REQUIREMENTS_DIR).filter(
			(file) => file.endsWith(".ts") && file !== ORCHESTRATOR_MODULE && file !== TYPE_ONLY_MODULE,
		);
		assert.ok(
			covered.length >= 6,
			`expected at least 6 runtime modules, found ${covered.length}: ${covered.join(", ")}`,
		);

		const orphans = covered.filter((module) => !imported.has(module));
		assert.deepStrictEqual(
			orphans,
			[],
			`modules the "Modules" suites do not import: ${orphans.join(", ")}`,
		);
	});

	it("keeps the exempt modules exempt for the stated reasons", () => {
		assert.ok(
			existsSync(join(REQUIREMENTS_DIR, ORCHESTRATOR_MODULE)),
			`${ORCHESTRATOR_MODULE} is the module the suites orchestrate — it must exist`,
		);
		const types = readFileSync(join(REQUIREMENTS_DIR, TYPE_ONLY_MODULE), "utf8");
		assert.equal(
			[...types.matchAll(FUNCTION_DECL)].length,
			0,
			`${TYPE_ONLY_MODULE} declares runtime functions — it is no longer type-only`,
		);
	});
});

interface VbaBaseline {
	provenance: { issue: number; title: string };
	before: { commit: string; files?: number; vbaGodModuleCount: number };
	after: { commit: string; vbaGodModuleCount: number };
	reducedBy: unknown[];
	deferred: Array<{ reason: string; files?: string[] }>;
}

const BASELINE_2006 = JSON.parse(read("test/fixtures/vba-god-module-baseline.json")) as VbaBaseline;
const BASELINE_2036 = JSON.parse(
	read("test/fixtures/vba-god-module-baseline-2036.json"),
) as VbaBaseline;

const DOC_2006 = resolve(REFERENCES_DIR, "vba-god-module-2006.md");
const DOC_2036 = resolve(REFERENCES_DIR, "vba-god-module-2036.md");

describe("Phase 4 — each reduction record agrees with its fixture", () => {
	it("pairs #2006's record with its own fixture", () => {
		assert.equal(BASELINE_2006.provenance.issue, 2006);
		assert.equal(BASELINE_2006.provenance.title, "VBA God Module");
		assert.match(read(DOC_2006), /^# VBA-god-module reduction record \(#2006/m);
	});

	it("agrees with #2006 on the measured base snapshot", () => {
		const doc = read(DOC_2006);
		assert.match(
			doc,
			/^\|\s*`origin\/main`\s*\|\s*`2b053c2b`\s*\|\s*922\s*\|\s*19\s*\|/m,
			"the #2006 record no longer carries the base row (origin/main, 2b053c2b, 922 files, 19 flagged)",
		);
		assert.equal(BASELINE_2006.before.vbaGodModuleCount, 19);
		assert.equal(BASELINE_2006.before.files, 922);
		assert.ok(
			BASELINE_2006.before.commit.startsWith("2b053c2b"),
			`fixture base commit drifted: ${BASELINE_2006.before.commit}`,
		);
	});

	it("agrees with #2006 that the Rust set is deferred, not removed", () => {
		assert.equal(BASELINE_2006.after.vbaGodModuleCount, 16);
		assert.ok(
			BASELINE_2006.deferred.length > 0,
			"#2006 legitimately keeps a deferral — an empty `deferred` contradicts its record",
		);

		const rust = BASELINE_2006.deferred.filter((entry) => (entry.files ?? []).length === 16);
		assert.equal(rust.length, 1, "the 16-file Rust deferral is no longer recorded as one group");
		assert.match(rust[0].reason, /rust/i, "the Rust deferral lost its no-toolchain reason");
		assert.match(
			flatten(read(DOC_2006)),
			/Sixteen `\.rs` files/,
			"the #2006 record no longer documents the sixteen deferred `.rs` files",
		);
	});

	it("pairs #2036's record with its own fixture", () => {
		assert.equal(BASELINE_2036.provenance.issue, 2036);
		assert.equal(BASELINE_2036.provenance.title, "VBA God Module");
		assert.match(read(DOC_2036), /^# VBA-god-module reduction record \(#2036/m);
	});

	it("agrees with #2036 that nothing is left flagged or deferred", () => {
		assert.equal(BASELINE_2036.before.vbaGodModuleCount, 25);
		assert.equal(BASELINE_2036.after.vbaGodModuleCount, 0);
		assert.equal(BASELINE_2036.deferred.length, 0);
		assert.equal(BASELINE_2036.reducedBy.length, 22);

		const doc = flatten(read(DOC_2036));
		assert.ok(
			doc.includes("`after.vbaGodModuleCount` is 0 and `deferred` is empty"),
			"the #2036 record no longer states that the after count is 0 and `deferred` is empty",
		);
		assert.ok(
			doc.includes("`reducedBy` holds the 22 cited reductions"),
			"the #2036 record no longer states the 22 cited reductions",
		);
	});
});
