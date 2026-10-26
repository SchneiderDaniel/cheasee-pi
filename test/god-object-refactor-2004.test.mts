// ─── God-object-files refactor contract (issue #2004) ─────────────
// CodeFlow's "God Object" metric is not a semantic detector. The pinned
// analyzer (`index.html` `detectPatterns`, ref below) emits it as
//   godFiles = analyzed.filter(f => f.isCode !== false && f.functions.length > 15)
// the *same* predicate behind the `N Large Files` architecture issue. The
// shared mirror (`test/fixtures/function-count-mirror.mts`) reproduces the
// analyzer's headless parser path (`Parser.extractOtherLanguages`)
// line-for-line, including the cross-language RULES pass that also runs over
// `.go` (which is why `codeflow_shim_test.go` counts 32, not its 21 `func`
// declarations).
//
// A split only moves the metric when EVERY sibling lands `<= 15`. This test is
// the in-gate oracle for that invariant; the recorded measurement (produced by
// the pinned `run-analysis.mjs` over `git archive` snapshots) lives in
// `test/fixtures/god-object-baseline.json` and is replayed by
// `test/codeflow-run-analysis.test.mts`.
//
// Run: node --experimental-strip-types --test test/god-object-refactor-2004.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ANALYZER_REF,
	CODE_EXTS,
	countFunctions,
	functionCountFlagged,
} from "./fixtures/function-count-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Files this change split, and the siblings each split produced. */
const TOUCHED: Record<string, string[]> = {
	// Go test files — split by scenario; whole decls move between files of
	// `package main`, so the compiler and the existing suite verify the move.
	"cmd/cheasee-pi/up_env_test.go": [
		"cmd/cheasee-pi/up_env_flags_test.go",
		"cmd/cheasee-pi/up_env_auth_test.go",
		"cmd/cheasee-pi/up_env_redact_test.go",
	],
	"cmd/cheasee-pi/codeflow_shim_test.go": [
		"cmd/cheasee-pi/codeflow_shim_harness_test.go",
		"cmd/cheasee-pi/codeflow_shim_entrypoint_test.go",
		"cmd/cheasee-pi/codeflow_shim_ext_test.go",
	],
	"cmd/cheasee-pi/init_split_test.go": [
		"cmd/cheasee-pi/init_split_layout_test.go",
		"cmd/cheasee-pi/init_split_decls_test.go",
		"cmd/cheasee-pi/init_split_size_test.go",
	],
	"cmd/cheasee-pi/helpers_test.go": [
		"cmd/cheasee-pi/helpers_models_test.go",
		"cmd/cheasee-pi/helpers_catalog_test.go",
		"cmd/cheasee-pi/helpers_runner_mocks_test.go",
	],
	"cmd/cheasee-pi/catalog_test.go": [
		"cmd/cheasee-pi/catalog_remote_test.go",
		"cmd/cheasee-pi/catalog_authadd_test.go",
		"cmd/cheasee-pi/catalog_initkeys_test.go",
	],
	"cmd/cheasee-pi/init_auth_test.go": [
		"cmd/cheasee-pi/init_auth_flow_test.go",
		"cmd/cheasee-pi/init_auth_reauth_test.go",
	],
	"cmd/cheasee-pi/init_clone_test.go": [
		"cmd/cheasee-pi/init_clone_flow_test.go",
		"cmd/cheasee-pi/init_clone_realgit_test.go",
	],
	"cmd/cheasee-pi/ui_e2e_test.go": ["cmd/cheasee-pi/ui_e2e_harness_test.go"],
	"cmd/cheasee-pi/up_flow_test.go": [
		"cmd/cheasee-pi/up_flow_journey_test.go",
		"cmd/cheasee-pi/up_flow_container_test.go",
	],
	"cmd/cheasee-pi/up_orphans_test.go": [
		"cmd/cheasee-pi/up_orphans_scan_test.go",
		"cmd/cheasee-pi/up_orphans_claim_test.go",
	],
	"cmd/cheasee-pi/helpers_run_test.go": ["cmd/cheasee-pi/helpers_run_fixture_test.go"],
	"cmd/cheasee-pi/init_skillrepos_test.go": [
		"cmd/cheasee-pi/init_skillrepos_loop_test.go",
		"cmd/cheasee-pi/init_skillrepos_terms_test.go",
	],
	// Production `package main` — split by responsibility.
	"cmd/cheasee-pi/identity.go": [
		"cmd/cheasee-pi/identity_gitremote.go",
		"cmd/cheasee-pi/identity_ports.go",
	],
	// Python registry clients — split by family; the original stays the barrel.
	"scripts/dependency_existence_check/registries.py": [
		"scripts/dependency_existence_check/registry_base.py",
		"scripts/dependency_existence_check/registry_json.py",
		"scripts/dependency_existence_check/registry_meta.py",
		"scripts/dependency_existence_check/registry_simple.py",
		"scripts/dependency_existence_check/registry_other.py",
	],
	"scripts/dependency_existence_check/transport.py": [
		"scripts/dependency_existence_check/cache.py",
	],
	// Refactor-invariant suite — thin `python3` entry + one module per scenario.
	"test/dependency-existence-check-refactor.test.py": [
		"test/dependency_existence_check_refactor/_common.py",
		"test/dependency_existence_check_refactor/test_baseline.py",
		"test/dependency_existence_check_refactor/test_cli_smoke.py",
		"test/dependency_existence_check_refactor/test_package_split.py",
		"test/dependency_existence_check_refactor/test_public_surface.py",
	],
};

const ALL_FILES = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

/** Analyzer counts per family on the base commit — whole decls move verbatim,
 * so the total across a family is invariant. The one raised entry is the codeflow
 * shim family: #2036's `server.py` split added the shared `stageCodeflowShim`
 * staging helper (32 -> 33) instead of moving an existing declaration. */
const BASE_COUNT: Record<string, number> = {
	"cmd/cheasee-pi/up_env_test.go": 34,
	"cmd/cheasee-pi/codeflow_shim_test.go": 33,
	"cmd/cheasee-pi/init_split_test.go": 30,
	"cmd/cheasee-pi/helpers_test.go": 28,
	"cmd/cheasee-pi/catalog_test.go": 27,
	"cmd/cheasee-pi/init_auth_test.go": 25,
	"cmd/cheasee-pi/init_clone_test.go": 25,
	"cmd/cheasee-pi/identity.go": 23,
	"cmd/cheasee-pi/ui_e2e_test.go": 21,
	"cmd/cheasee-pi/up_flow_test.go": 21,
	"cmd/cheasee-pi/up_orphans_test.go": 20,
	"cmd/cheasee-pi/helpers_run_test.go": 19,
	"cmd/cheasee-pi/init_skillrepos_test.go": 16,
	"scripts/dependency_existence_check/registries.py": 42,
	"scripts/dependency_existence_check/transport.py": 19,
	"test/dependency-existence-check-refactor.test.py": 17,
};

/** The production files in the manifest (not `_test.go`). */
const PRODUCTION = new Set([
	"cmd/cheasee-pi/identity.go",
	"cmd/cheasee-pi/identity_gitremote.go",
	"cmd/cheasee-pi/identity_ports.go",
]);

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");

// ─── The mirror mirrors the pinned detector ───────────────────────

describe("god-object refactor #2004 — the mirror is the pinned detector", () => {
	it("pins the 40-hex analyzer ref", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
	});

	it("has teeth at the exact boundary (strictly more than 15)", () => {
		const mk = (n: number): string =>
			Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join("\n");
		assert.equal(countFunctions(mk(15), "ts"), 15);
		assert.equal(
			functionCountFlagged(mk(15), "x.ts", 15),
			false,
			"15 functions must not be flagged",
		);
		assert.equal(countFunctions(mk(16), "ts"), 16);
		assert.equal(functionCountFlagged(mk(16), "x.ts", 15), true, "16 functions must be flagged");
	});

	it("is not vacuous", () => {
		assert.equal(countFunctions("", "ts"), 0);
		const src = Array.from({ length: 16 }, (_, i) => `export function f${i}() {}`).join("\n");
		assert.equal(countFunctions(src, "ts"), 16);
	});

	it("gates `.mts` out (absent from codeExts) but scores the same text as `.ts`", () => {
		assert.equal(CODE_EXTS.includes(".mts"), false, "`.mts` is not a code ext");
		const src = Array.from({ length: 16 }, (_, i) => `export function f${i}() {}`).join("\n");
		assert.equal(
			functionCountFlagged(src, "sample.mts", 15),
			false,
			"the .mts oracle is never itself scored",
		);
		assert.equal(
			functionCountFlagged(src, "sample.ts", 15),
			true,
			"the same text as .ts is scored",
		);
	});

	it("runs the cross-language RULES pass over .go too", () => {
		// The `.go` branch counts `func` decls AND the shared RULES pass, which is
		// how `codeflow_shim_test.go` counts 32 rather than its 21 `func Test...`.
		const src = "func TestOne(t *testing.T) {\n\tif err != nil {\n\t}\n}\n";
		assert.equal(countFunctions(src, "go"), 1);
		const many = "func TestOne(t *testing.T) {}\nfunc TestTwo(t *testing.T) {}\n";
		assert.equal(countFunctions(many, "go"), 2);
	});
});

// ─── Manifest ─────────────────────────────────────────────────────

describe("god-object refactor #2004 — manifest", () => {
	it("lists the 12 Go split families, the production split and the Python files", () => {
		const go = Object.keys(TOUCHED).filter((r) => r.endsWith(".go"));
		assert.ok(go.length >= 13, `expected >=13 Go families, got ${go.length}`);
		assert.ok(TOUCHED["cmd/cheasee-pi/identity.go"], "the production split is listed");
		for (const rel of [
			"scripts/dependency_existence_check/registries.py",
			"scripts/dependency_existence_check/transport.py",
			"test/dependency-existence-check-refactor.test.py",
		]) {
			assert.ok(TOUCHED[rel], `${rel} must be a split family`);
		}
	});

	it("every family produced at least one sibling module", () => {
		for (const [rel, siblings] of Object.entries(TOUCHED)) {
			assert.ok(siblings.length >= 1, `${rel} lists no sibling module`);
		}
	});

	it("every listed file exists and is listed once", () => {
		for (const rel of ALL_FILES) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing manifest file: ${rel}`);
		}
		assert.equal(new Set(ALL_FILES).size, ALL_FILES.length, "a file is listed twice");
	});

	it("preserves every declaration: the split moved decls verbatim", () => {
		for (const [rel, siblings] of Object.entries(TOUCHED)) {
			const ext = rel.split(".").pop()!;
			const now =
				countFunctions(read(rel), ext) +
				siblings.reduce((n, s) => n + countFunctions(read(s), s.split(".").pop()!), 0);
			assert.equal(now, BASE_COUNT[rel], `${rel}: ${now} functions, expected ${BASE_COUNT[rel]}`);
		}
	});

	it("cites no `.mts` as a reduction source", () => {
		for (const rel of ALL_FILES) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is never counted by the analyzer`);
		}
	});

	it("keeps the Go members in package main (and test siblings as _test.go)", () => {
		for (const rel of ALL_FILES) {
			if (!rel.endsWith(".go")) continue;
			assert.match(read(rel), /^package main$/m, `${rel} left package main`);
			if (!PRODUCTION.has(rel)) {
				assert.ok(rel.endsWith("_test.go"), `${rel} is neither the production file nor a test`);
			}
		}
	});

	it("is acyclic: no sibling imports the module it was split from", () => {
		const forbidden: Record<string, RegExp> = {
			"scripts/dependency_existence_check/registries.py": /from\s+\.\s*registries\s+import/,
			"scripts/dependency_existence_check/transport.py": /from\s+\.\s*transport\s+import/,
		};
		for (const [origin, siblings] of Object.entries(TOUCHED)) {
			const pattern = forbidden[origin];
			if (!pattern) continue;
			for (const sib of siblings) {
				assert.ok(!pattern.test(read(sib)), `${sib} imports the module it was split from`);
			}
		}
		for (const sib of TOUCHED["test/dependency-existence-check-refactor.test.py"]) {
			assert.ok(
				!read(sib).includes("dependency_existence_check_refactor.test_"),
				`${sib} imports a sibling scenario module`,
			);
		}
	});
});

// ─── The invariant that makes the metric fall ─────────────────────

describe("god-object refactor #2004 — every file is under the metric", () => {
	for (const rel of ALL_FILES) {
		it(`${rel} counts <= 15 and is not flagged`, () => {
			const src = read(rel);
			const count = countFunctions(src, rel.split(".").pop()!);
			assert.ok(count <= 15, `${rel} counts ${count} (ceiling 15)`);
			assert.equal(functionCountFlagged(src, rel, 15), false, `${rel} is still flagged`);
		});
	}
});

// ─── Preserved surface ────────────────────────────────────────────

describe("god-object refactor #2004 — composition roots survive the split", () => {
	it("registries.py stays the barrel and exposes REGISTRIES plus every client", () => {
		const src = read("scripts/dependency_existence_check/registries.py");
		for (const sym of [
			"Registry",
			"PypiRegistry",
			"NpmRegistry",
			"GoRegistry",
			"CargoRegistry",
			"MavenRegistry",
			"NugetRegistry",
			"VcpkgRegistry",
			"ConanRegistry",
			"RubygemsRegistry",
			"PackagistRegistry",
			"SwiftRegistry",
			"PubRegistry",
			"REGISTRIES",
		]) {
			assert.ok(new RegExp(`\\b${sym}\\b`).test(src), `registries.py must still expose ${sym}`);
		}
		assert.ok(!/import\s+\*/.test(src), "registries.py must not wildcard-import");
	});

	it("transport.py re-exports the cache symbols it split out", () => {
		const src = read("scripts/dependency_existence_check/transport.py");
		assert.match(src, /from\s+\.\s*cache\s+import/);
		for (const sym of ["CacheStats", "DiskCache", "NoCache"]) {
			assert.ok(new RegExp(`\\b${sym}\\b`).test(src), `transport.py must still expose ${sym}`);
		}
	});

	it("the package __init__ still exposes the documented public surface", () => {
		const src = read("scripts/dependency_existence_check/__init__.py");
		for (const sym of [
			"REGISTRIES",
			"DiskCache",
			"RealFetcher",
			"USER_AGENT",
			"CacheStats",
			"RateLimiter",
			"NoCache",
		]) {
			assert.ok(new RegExp(`\\b${sym}\\b`).test(src), `__init__.py must still expose ${sym}`);
		}
	});

	it("identity.go still declares the exposed surface its callers use", () => {
		const src = [
			read("cmd/cheasee-pi/identity.go"),
			read("cmd/cheasee-pi/identity_gitremote.go"),
			read("cmd/cheasee-pi/identity_ports.go"),
		].join("\n");
		for (const sym of [
			"parseGitRemote",
			"portSpec",
			"resolveUIHostPort",
			"uiContainerName",
			"parseGitHubRemote",
			"repoSlug",
		]) {
			assert.ok(
				new RegExp(`\\b(?:func|type|var|const)\\s+${sym}\\b`).test(src),
				`identity split lost ${sym}`,
			);
		}
	});

	it("keeps the documented go test families named in the baseline fixture", () => {
		const baseline = JSON.parse(read("test/fixtures/god-object-baseline.json")) as {
			reducedBy: string[];
		};
		for (const rel of Object.keys(TOUCHED)) {
			assert.ok(
				baseline.reducedBy.includes(rel),
				`baseline.reducedBy is missing the split family ${rel}`,
			);
		}
	});
});
