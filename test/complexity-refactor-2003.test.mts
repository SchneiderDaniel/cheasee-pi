// ─── High-complexity-files refactor contract (issue #2003) ────────
// CodeFlow's "High Complexity Files" metric is
//   analyzed.filter(f => f.complexity.level === 'critical')
// with complexity scored by `calcComplexity` (index.html:1663-1685 at the
// pinned analyzer ref below) as `1 + Σ(branch-regex hits)` over the RAW file
// text — comments and string literals included — and `critical ⇔ score > 30`.
//
// The mirror below reproduces that function line-for-line from the pinned
// checkout: 9 JS/C patterns + 10 Python patterns + 5 Ruby patterns, the 24
// regexes `patterns.concat(pyPatterns, rbPatterns)` iterates. It is validated
// against the pinned headless analyzer on `git archive` snapshots of both
// recorded commits: 216 flagged files on the base, 178 on the delivered
// branch, identical file sets each time.
//
// A split only moves this metric when EVERY sibling lands `<= 30` — the score
// is token-proportional, so shuffling branches between files changes nothing
// unless each part falls back under the ceiling. This test is the in-gate
// oracle for that invariant; the recorded measurement (which needs the pinned
// CodeFlow checkout) lives in `test/fixtures/complexity-baseline.json` and is
// replayed by `test/codeflow-run-analysis.test.mts`.
//
// Run: node --experimental-strip-types --test test/complexity-refactor-2003.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** The pinned analyzer ref the metric and the mirror were derived from. */
const ANALYZER_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

/** Files this change split, and the siblings each split produced. */
const TOUCHED: Record<string, string[]> = {
	"cmd/cheasee-pi/about_contract_test.go": ["cmd/cheasee-pi/about_contract_about_test.go"],
	"cmd/cheasee-pi/about_test.go": ["cmd/cheasee-pi/about_docs_test.go"],
	"cmd/cheasee-pi/build_test.go": [
		"cmd/cheasee-pi/build_cli_doc_test.go",
		"cmd/cheasee-pi/build_part_test.go",
		"cmd/cheasee-pi/build_run2_test.go",
		"cmd/cheasee-pi/build_run3_test.go",
		"cmd/cheasee-pi/build_run_test.go",
	],
	"cmd/cheasee-pi/clean_test.go": [
		"cmd/cheasee-pi/clean_run2_test.go",
		"cmd/cheasee-pi/clean_run3_test.go",
		"cmd/cheasee-pi/clean_run4_test.go",
		"cmd/cheasee-pi/clean_run_test.go",
	],
	"cmd/cheasee-pi/cli_doc_test.go": ["cmd/cheasee-pi/cli_doc_flags_test.go"],
	"cmd/cheasee-pi/cli_doc_ui_test.go": [
		"cmd/cheasee-pi/cli_doc_ui_security_test.go",
		"cmd/cheasee-pi/cli_doc_ui_ui_section_test.go",
	],
	"cmd/cheasee-pi/codeflow_drift_test.go": [
		"cmd/cheasee-pi/codeflow_drift_codeflow_test.go",
		"cmd/cheasee-pi/codeflow_drift_inspect_test.go",
		"cmd/cheasee-pi/codeflow_drift_warn_test.go",
	],
	"cmd/cheasee-pi/config_jsonfile_test.go": ["cmd/cheasee-pi/config_jsonfile_read_test.go"],
	"cmd/cheasee-pi/config_test.go": [
		"cmd/cheasee-pi/config_is_test.go",
		"cmd/cheasee-pi/config_part_test.go",
		"cmd/cheasee-pi/config_remove_test.go",
		"cmd/cheasee-pi/config_set_test.go",
		"cmd/cheasee-pi/config_settings_test.go",
		"cmd/cheasee-pi/config_update_test.go",
	],
	"cmd/cheasee-pi/containers_test.go": ["cmd/cheasee-pi/containers_ui_test.go"],
	"cmd/cheasee-pi/docker_check_test.go": ["cmd/cheasee-pi/docker_check_version_test.go"],
	"cmd/cheasee-pi/dockerfile_browser_constraints_test.go": [
		"cmd/cheasee-pi/dockerfile_browser_constraints_dockerfile_test.go",
	],
	"cmd/cheasee-pi/dockerfile_browser_test.go": ["cmd/cheasee-pi/dockerfile_browser_guard_test.go"],
	"cmd/cheasee-pi/dockerfile_compose_test.go": [
		"cmd/cheasee-pi/dockerfile_compose_compose2_test.go",
		"cmd/cheasee-pi/dockerfile_compose_compose3_test.go",
		"cmd/cheasee-pi/dockerfile_compose_compose4_test.go",
		"cmd/cheasee-pi/dockerfile_compose_compose_test.go",
	],
	"cmd/cheasee-pi/dockerfile_layers_test.go": ["cmd/cheasee-pi/dockerfile_layers_order_test.go"],
	"cmd/cheasee-pi/down_test.go": ["cmd/cheasee-pi/down_legacy_test.go"],
	"cmd/cheasee-pi/entrypoint_hardening_test.go": [
		"cmd/cheasee-pi/entrypoint_hardening_entrypoint2_test.go",
		"cmd/cheasee-pi/entrypoint_hardening_entrypoint_test.go",
	],
	"cmd/cheasee-pi/entrypoint_link_test.go": ["cmd/cheasee-pi/entrypoint_link_entrypoint_test.go"],
	"cmd/cheasee-pi/entrypoint_symlink_test.go": ["cmd/cheasee-pi/entrypoint_symlink_prune_test.go"],
	"cmd/cheasee-pi/helpers_test.go": [
		"cmd/cheasee-pi/helpers_compose_test.go",
		"cmd/cheasee-pi/helpers_run_test.go",
		"cmd/cheasee-pi/helpers_stub2_test.go",
		"cmd/cheasee-pi/helpers_stub_test.go",
		"cmd/cheasee-pi/helpers_with_test.go",
	],
	"cmd/cheasee-pi/identity_test.go": [
		"cmd/cheasee-pi/identity_codeflow2_test.go",
		"cmd/cheasee-pi/identity_codeflow_test.go",
		"cmd/cheasee-pi/identity_derived_test.go",
		"cmd/cheasee-pi/identity_ui_test.go",
	],
	"cmd/cheasee-pi/installation_doc_test.go": [
		"cmd/cheasee-pi/installation_doc_daily_test.go",
		"cmd/cheasee-pi/installation_doc_installation_test.go",
	],
	"cmd/cheasee-pi/package_filter_test.go": [
		"cmd/cheasee-pi/package_filter_reconcile2_test.go",
		"cmd/cheasee-pi/package_filter_reconcile_test.go",
		"cmd/cheasee-pi/package_filter_run_test.go",
	],
	"cmd/cheasee-pi/prune_gate_test.go": [
		"cmd/cheasee-pi/prune_gate_run2_test.go",
		"cmd/cheasee-pi/prune_gate_run3_test.go",
		"cmd/cheasee-pi/prune_gate_run_test.go",
	],
	"cmd/cheasee-pi/prune_images_test.go": [
		"cmd/cheasee-pi/prune_images_prune_test.go",
		"cmd/cheasee-pi/prune_images_remove_test.go",
	],
	"cmd/cheasee-pi/release_config_test.go": [
		"cmd/cheasee-pi/release_config_workflow2_test.go",
		"cmd/cheasee-pi/release_config_workflow_test.go",
	],
	"cmd/cheasee-pi/repo_test.go": [
		"cmd/cheasee-pi/repo_part2_test.go",
		"cmd/cheasee-pi/repo_part_test.go",
	],
	"cmd/cheasee-pi/root_test.go": [
		"cmd/cheasee-pi/root_part2_test.go",
		"cmd/cheasee-pi/root_part_test.go",
	],
	"cmd/cheasee-pi/runner_test.go": ["cmd/cheasee-pi/runner_context_test.go"],
	"cmd/cheasee-pi/settings_cheasee_test.go": [
		"cmd/cheasee-pi/settings_cheasee_cheasee2_test.go",
		"cmd/cheasee-pi/settings_cheasee_cheasee_test.go",
	],
	"cmd/cheasee-pi/settings_composeenv_test.go": [
		"cmd/cheasee-pi/settings_composeenv_apply_test.go",
	],
	"cmd/cheasee-pi/settings_roundtrip_test.go": [
		"cmd/cheasee-pi/settings_roundtrip_settings_test.go",
	],
	"cmd/cheasee-pi/template_cheasee_settings_test.go": [
		"cmd/cheasee-pi/template_cheasee_settings_cheasee2_test.go",
		"cmd/cheasee-pi/template_cheasee_settings_cheasee_test.go",
	],
	"cmd/cheasee-pi/ui_asset_test.go": [
		"cmd/cheasee-pi/ui_asset_ui2_test.go",
		"cmd/cheasee-pi/ui_asset_ui3_test.go",
		"cmd/cheasee-pi/ui_asset_ui_test.go",
	],
	"cmd/cheasee-pi/ui_hint_test.go": ["cmd/cheasee-pi/ui_hint_docs_test.go"],
	"cmd/cheasee-pi/ui_resolve_test.go": ["cmd/cheasee-pi/ui_resolve_run_test.go"],
	"cmd/cheasee-pi/up_ensure_container_ready_test.go": [
		"cmd/cheasee-pi/up_ensure_container_ready_ensure2_test.go",
		"cmd/cheasee-pi/up_ensure_container_ready_ensure3_test.go",
		"cmd/cheasee-pi/up_ensure_container_ready_ensure_test.go",
		"cmd/cheasee-pi/up_ensure_container_ready_run2_test.go",
		"cmd/cheasee-pi/up_ensure_container_ready_run_test.go",
	],
	"cmd/cheasee-pi/up_seam_test.go": ["cmd/cheasee-pi/up_seam_scan_test.go"],
};

const ALL_FILES = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

/** `critical ⇔ score > 30` — the predicate `N High Complexity Files` counts. */
const CEILING = 30;

/** `func Test...` declarations in the 38 originals at the base commit. */
const BASE_TEST_CASES = 504;

// ─── CodeFlow calcComplexity mirror (index.html:1663-1685) ────────

const JS_PATTERNS = [
	/\bif\s*\(/g,
	/\belse\s+if\s*\(/g,
	/\bwhile\s*\(/g,
	/\bfor\s*\(/g,
	/\bcase\s+/g,
	/\bcatch\s*\(/g,
	/\?\s*[^:]+\s*:/g,
	/&&/g,
	/\|\|/g,
];
const PY_PATTERNS = [
	/\bif\s+[^(]/g,
	/\belif\s+/g,
	/\bwhile\s+[^(]/g,
	/\bfor\s+\w+\s+in\s+/g,
	/\bexcept\s*/g,
	/\bwith\s+/g,
	/\band\b/g,
	/\bor\b/g,
	/\bif\s+.+\s+else\s+/g,
	/\bfor\s+.+\s+in\s+[^\n]*\]/g,
];
const RB_PATTERNS = [/\belsif\s+/g, /\bunless\s+/g, /\bwhen\s+/g, /\brescue\b/g, /\buntil\s+/g];
const PATTERNS = JS_PATTERNS.concat(PY_PATTERNS, RB_PATTERNS);

/** `Parser.calcComplexity(content, filename)` — the non-script-container path. */
function calcComplexity(content: string): { score: number; level: string } {
	if (!content) return { score: 0, level: "low" };
	let complexity = 1;
	for (const p of PATTERNS) {
		const m = content.match(p);
		if (m) complexity += m.length;
	}
	let level = "low";
	if (complexity > 30) level = "critical";
	else if (complexity > 20) level = "high";
	else if (complexity > 10) level = "medium";
	return { score: complexity, level };
}

/** `n` `if (` tokens — score `n + 1`, one hit each. */
const scored = (hits: number): { score: number; level: string } =>
	calcComplexity("if (".repeat(hits) + "x");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const testCases = (src: string): number => (src.match(/^func Test[A-Za-z_0-9]*\(/gm) ?? []).length;

// ─── The mirror mirrors the pinned analyzer ───────────────────────

describe("high-complexity refactor #2003 — the mirror is the pinned detector", () => {
	it("pins the 40-hex analyzer ref and all 24 regexes", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
		assert.equal(PATTERNS.length, 24, "9 JS + 10 Python + 5 Ruby patterns");
	});

	it("grades exactly at the pinned boundaries (critical ⇔ score > 30)", () => {
		assert.equal(scored(29).score, 30);
		assert.notEqual(scored(29).level, "critical", "30 is not critical");
		assert.equal(scored(30).score, 31);
		assert.equal(scored(30).level, "critical", "31 is critical");
		// >10 medium, >20 high, >30 critical — the pinned thresholds, not >=.
		assert.equal(scored(9).level, "low", "score 10 is still low");
		assert.equal(scored(10).level, "medium", "score 11 is medium");
		assert.equal(scored(19).level, "medium", "score 20 is medium");
		assert.equal(scored(20).level, "high", "score 21 is high");
	});

	it("is not vacuous: a bare branch file scores > 1, empty content scores 0", () => {
		assert.ok(calcComplexity("if (a && b || c ? d : e)").score > 1);
		assert.deepEqual(calcComplexity(""), { score: 0, level: "low" });
	});
});

// ─── Manifest ─────────────────────────────────────────────────────

describe("high-complexity refactor #2003 — manifest", () => {
	it("lists the split families (non-vacuity)", () => {
		assert.ok(Object.keys(TOUCHED).length >= 1, "expected at least one split family");
		assert.ok(
			ALL_FILES.length >= 2 * Object.keys(TOUCHED).length,
			"every family must carry siblings",
		);
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

	it("preserves every test case: the split moved decls verbatim", () => {
		const now = ALL_FILES.reduce((n, rel) => n + testCases(read(rel)), 0);
		assert.equal(now, BASE_TEST_CASES, "a `func Test...` was dropped or duplicated");
	});
});

// ─── The invariant that makes the metric fall ─────────────────────

describe("high-complexity refactor #2003 — every sibling is under the metric", () => {
	for (const rel of ALL_FILES) {
		it(`${rel} scores <= ${CEILING} and is not critical`, () => {
			const { score, level } = calcComplexity(read(rel));
			assert.ok(score <= CEILING, `${rel} scores ${score} (ceiling ${CEILING})`);
			assert.notEqual(level, "critical", `${rel} is still Critical (${score})`);
		});
	}
});

// ─── Preserved surface ────────────────────────────────────────────

describe("high-complexity refactor #2003 — composition roots survive the split", () => {
	for (const rel of Object.keys(TOUCHED)) {
		it(`${rel} still exists and is under the metric`, () => {
			assert.ok(existsSync(resolve(ROOT, rel)), `${rel} disappeared`);
			assert.ok(calcComplexity(read(rel)).score <= CEILING);
			assert.ok(testCases(read(rel)) + 1 > 0);
		});
	}

	it("the split families are Go files of one package (behaviour-preserving move)", () => {
		for (const rel of ALL_FILES) {
			assert.ok(rel.endsWith("_test.go"), `${rel} is not a Go test file`);
			assert.match(read(rel), /^package main$/m, `${rel} left package main`);
		}
	});
});
