// ─── God-object-files refactor contract (issue #2034) ─────────────
// CodeFlow's "God Object" metric is not a semantic detector. The pinned
// analyzer (`index.html` `detectPatterns`, ref below) emits it as
//   godFiles = analyzed.filter(f => f.isCode !== false && f.functions.length > 15)
// the *same* predicate behind the `N Large Files` architecture issue. The
// shared mirror (`test/fixtures/function-count-mirror.mts`) reproduces the
// analyzer's headless parser path line-for-line — no detector literal is
// duplicated here.
//
// The issue files 43 paths, but only 23 of them are flagged by the pinned
// analyzer at the base commit (5 are `.mts`, absent from CODE_EXTS; 15 count
// 4-14). This oracle pins the whole partition — `reducedBy` / `deferred` /
// `notScored` — so the 20 non-flagged paths are recorded rather than silently
// dropped, and every remaining flag carries the `requires` the next issue
// needs.
//
// A split only moves the metric when EVERY sibling lands `<= 15`. The recorded
// measurement lives in `test/fixtures/god-object-2034-baseline.json`.
//
// The Go split's behavioural proof is the filtered `go test` in the documented
// runnable command (the compiler proves the move, the suite proves no test was
// dropped); this file spawns `python3` only, for the discovery guard.
//
// Run: node --experimental-strip-types --test test/god-object-refactor-2034.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const ext = (rel: string): string => rel.split(".").pop()!;
const count = (rel: string): number => countFunctions(read(rel), ext(rel));
const flagged = (rel: string): boolean => functionCountFlagged(read(rel), rel, 15);
const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));

type Baseline = {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedAnalyzedAt: number;
		filedCount: number;
	};
	before: { ref: string; commit: string; godObjectCount: number; flagged: string[] };
	after: { ref: string; godObjectCount: number };
	reducedBy: string[];
	deferred: { reason: string; requires: string; files: string[] }[];
	notScored: { reason: string; files: string[] }[];
};

const baseline = (): Baseline =>
	JSON.parse(read("test/fixtures/god-object-2034-baseline.json")) as Baseline;

/** The 43 paths the issue files (`patterns[God Object].files` at analyzedAt). */
const FILED = [
	".pi/extensions/agent-harness/test/harness-fixtures.ts",
	".pi/extensions/caveman/test/config-ui.test.ts",
	".pi/extensions/context-info/test/context-info.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts",
	".pi/extensions/rtk/test/version-gate-lifecycle.test.ts",
	".pi/extensions/scrapling/test/browser-setup.test.ts",
	".pi/extensions/supervisor/event/adapter/normalize.ts",
	".pi/extensions/supervisor/github/octokit-client.ts",
	".pi/extensions/supervisor/lib/debug.ts",
	".pi/extensions/supervisor/lib/render-helpers.ts",
	".pi/extensions/supervisor/pipeline/error-collector.ts",
	".pi/extensions/supervisor/test/dead-code-file-classification-removal.test.mts",
	".pi/extensions/supervisor/test/helpers/mock-ctx.ts",
	".pi/extensions/supervisor/test/helpers/mock-pi.ts",
	".pi/extensions/supervisor/test/pipeline/merge.test.mts",
	".pi/skills/audit-codeflow-analysis/lib/fetch-report.ts",
	".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts",
	"cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js",
	"cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs",
	"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
	"cmd/cheasee-pi/embedded/docker/ui/src/auth.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/bash.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/main.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/pi_process.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/retry.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/rpc/client.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/rpc/framing.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/session.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/stream.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/ws.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/event_widgets.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/extension_ui.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/reconnect.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/rpc_protocol.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/session_controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/stream_assembly.rs",
	"test/dependency_existence_check_tests/_common.py",
	"test/dependency_existence_check_tests/test_adapter_extraction.py",
	"test/dependency_existence_check_tests/test_pipeline_age_guard.py",
	"test/dependency_existence_check_tests/test_registry_transport.py",
];

/** The one flagged file this change splits although the issue does not cite it. */
const UNCITED_REDUCED = ["cmd/cheasee-pi/disk_space_test.go"];

/** Files this change split, and the siblings each split produced. */
const TOUCHED: Record<string, string[]> = {
	// Python harness — barrel + route shapes + transport fake.
	"test/dependency_existence_check_tests/_common.py": [
		"test/dependency_existence_check_tests/_routes.py",
		"test/dependency_existence_check_tests/_fakes.py",
	],
	// Python scenario module — shared lifecycle to `_bases.py`, CLI/report
	// scenarios to a new sibling (the runner must import it or it never runs).
	"test/dependency_existence_check_tests/test_pipeline_age_guard.py": [
		"test/dependency_existence_check_tests/test_cli_report_contract.py",
	],
	// Go test file — split by scenario family; whole decls move between files
	// of `package main`, so the compiler and the existing suite verify the move.
	"cmd/cheasee-pi/disk_space_test.go": [
		"cmd/cheasee-pi/disk_space_stub_test.go",
		"cmd/cheasee-pi/disk_space_compose_test.go",
	],
};

const FAMILY = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

/** Analyzer counts per family at base — whole decls move verbatim. */
const BASE_COUNT: Record<string, number> = {
	"test/dependency_existence_check_tests/_common.py": 16,
	"test/dependency_existence_check_tests/test_pipeline_age_guard.py": 16,
	"cmd/cheasee-pi/disk_space_test.go": 26,
};

/** Every `class`/`def` name in a `.py` family (multiset, so a lost one shows). */
const pyDecls = (src: string): string[] =>
	[...src.matchAll(/^\s*(?:class|def)\s+(\w+)/gm)].map((m) => m[1]!);

/** Every top-level `func` name in a `.go` family. */
const goDecls = (src: string): string[] =>
	[...src.matchAll(/^func\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]!);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GC = "test/dependency_existence_check_tests";

// ─── The mirror mirrors the pinned detector ───────────────────────

describe("god-object refactor #2034 — the mirror is the pinned detector", () => {
	const mk = (n: number): string =>
		Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join("\n");

	it("pins the 40-hex analyzer ref", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
	});

	it("has teeth at the exact boundary (strictly more than 15)", () => {
		assert.equal(countFunctions(mk(15), "ts"), 15);
		assert.equal(functionCountFlagged(mk(15), "x.ts", 15), false, "15 must not be flagged");
		assert.equal(countFunctions(mk(16), "ts"), 16);
		assert.equal(functionCountFlagged(mk(16), "x.ts", 15), true, "16 must be flagged");
	});

	it("is not vacuous", () => {
		assert.equal(countFunctions("", "ts"), 0);
	});

	it("gates `.mts` out but scores the same text as `.ts`", () => {
		assert.equal(CODE_EXTS.includes(".mts"), false, "`.mts` is not a code ext");
		assert.equal(functionCountFlagged(mk(16), "sample.mts", 15), false);
		assert.equal(functionCountFlagged(mk(16), "sample.ts", 15), true);
	});

	it("counts .py class lines and nested defs", () => {
		const src = "class A:\n    def f(self):\n        pass\n";
		assert.equal(countFunctions(src, "py"), 2, "class A + def f");
		assert.equal(countFunctions("def outer():\n    def inner():\n        pass\n", "py"), 2);
	});

	it("runs the cross-language RULES pass over .go too", () => {
		assert.equal(countFunctions("func One() {}\n", "go"), 1);
		assert.equal(countFunctions("func One() {}\nfunc Two() {}\n", "go"), 2);
	});
});

// ─── The 43-file partition ────────────────────────────────────────

describe("god-object refactor #2034 — the partition is explicit", () => {
	it("records the filed provenance verbatim", () => {
		const p = baseline().provenance;
		assert.equal(p.issue, 2034);
		assert.equal(p.filedCount, 43);
		assert.equal(p.filedAnalyzedAt, 1791804971015);
		assert.match(p.ref, /^[0-9a-f]{40}$/);
		assert.match(p.metric, /functions\.length > 15/);
		assert.match(p.metric, /isCode !== false/);
	});

	it("covers the filed list exactly: no path dropped, invented or duplicated", () => {
		const b = baseline();
		const partition = [
			...b.reducedBy,
			...b.deferred.flatMap((d) => d.files),
			...b.notScored.flatMap((n) => n.files),
		];
		assert.equal(new Set(partition).size, partition.length, "a path is listed twice");
		assert.deepEqual([...partition].sort(), [...FILED].sort(), "partition != filed list");
		for (const rel of FILED) assert.ok(exists(rel), `filed path is missing: ${rel}`);
	});

	it("keeps the buckets disjoint with the recorded sizes", () => {
		const b = baseline();
		const reduced = new Set(b.reducedBy);
		const deferred = new Set(b.deferred.flatMap((d) => d.files));
		const notScored = new Set(b.notScored.flatMap((n) => n.files));
		for (const rel of reduced) {
			assert.equal(deferred.has(rel), false, `${rel} is reduced and deferred`);
			assert.equal(notScored.has(rel), false, `${rel} is reduced and notScored`);
		}
		for (const rel of deferred) assert.equal(notScored.has(rel), false, `${rel} twice`);
		assert.equal(b.reducedBy.length, 2);
		assert.equal(deferred.size, 21);
		assert.equal(notScored.size, 20);
	});

	it("justifies every notScored path: the .mts group is the CODE_EXTS gate", () => {
		const b = baseline();
		const mts = b.notScored.filter((n) => n.files.some((f) => f.endsWith(".mts")));
		assert.equal(mts.length, 1, "the .mts reason is recorded once");
		assert.equal(mts[0]!.files.length, 5, "exactly the 5 filed .mts paths");
		assert.match(mts[0]!.reason, /CODE_EXTS/);
		for (const group of b.notScored) {
			assert.ok(group.reason.trim().length > 0, "every notScored group needs a reason");
			for (const rel of group.files) {
				if (rel.endsWith(".mts")) continue;
				assert.match(rel, /\.(py|js|mjs|ts)$/, `${rel} is not scored by the analyzer`);
				assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)} — not "notScored"`);
				assert.equal(flagged(rel), false, `${rel} is flagged, so it is not notScored`);
			}
		}
	});

	it("records the base measurement: 24 flagged, not the filed 43", () => {
		const { before } = baseline();
		assert.match(before.commit, /^[0-9a-f]{40}$/);
		assert.equal(before.flagged.length, 24);
		assert.equal(new Set(before.flagged).size, 24, "a base file is listed twice");
		assert.equal(before.godObjectCount, before.flagged.length);
		for (const rel of before.flagged) assert.ok(exists(rel), `missing: ${rel}`);
	});

	it("cites no `.mts` as a reduction source", () => {
		for (const rel of [...baseline().reducedBy, ...UNCITED_REDUCED]) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is never scored by the analyzer`);
		}
	});
});

// ─── Phase 2: `_common.py` -> barrel + `_routes.py` + `_fakes.py` ─

describe("god-object refactor #2034 — the Python harness family", () => {
	const common = `${GC}/_common.py`;
	const routes = `${GC}/_routes.py`;
	const fakes = `${GC}/_fakes.py`;

	it("moves whole declarations: the family still counts 16", () => {
		const sum = [common, routes, fakes].reduce((n, rel) => n + count(rel), 0);
		assert.equal(sum, BASE_COUNT[common], `family counts ${sum}`);
	});

	it("preserves the base declaration name-set exactly", () => {
		const base = [
			"iso_days_ago",
			"pypi_body",
			"run_main",
			"url_for",
			"_netloc",
			"ok_route",
			"not_found_route",
			"make_response",
			"write_repo",
			"FakeFetcher",
			"_Stats",
			"__init__",
			"__init__",
			"cache_entry",
			"get",
			"requested_urls",
		];
		const now = [common, routes, fakes].flatMap((rel) => pyDecls(read(rel)));
		assert.deepEqual([...now].sort(), [...base].sort());
		assert.equal(now.length, 16, "_Stats/__init__ appear twice, so 16 decls");
	});

	it("keeps the barrel surface the scenario modules star-import", () => {
		const src = read(common);
		for (const sym of [
			"dec",
			"_HERE",
			"_SCRIPTS",
			"OLD_ISO",
			"FakeFetcher",
			"run_main",
			"write_repo",
			"iso_days_ago",
			"pypi_body",
			"url_for",
			"_netloc",
			"ok_route",
			"not_found_route",
			"make_response",
		]) {
			assert.match(src, new RegExp(`\\b${escape(sym)}\\b`), `barrel must still bind ${sym}`);
		}
		// `unittest`, `json`, `Path` ... also reach the scenario modules through
		// the star import, including `_bases.py` which imports nothing itself.
		for (const sym of ["unittest", "json", "Path", "_dt", "timedelta", "timezone"]) {
			assert.match(src, new RegExp(`\\b${escape(sym)}\\b`), `barrel must still bind ${sym}`);
		}
	});

	it("re-exports the siblings explicitly — no wildcard propagation", () => {
		const src = read(common);
		assert.doesNotMatch(src, /^from \._\w+ import \*$/m, "no wildcard re-export");
		assert.match(src, /^from \._routes import /m);
		assert.match(src, /^from \._fakes import /m);
	});

	it("binds `dec` before the siblings import it back (cycle safety)", () => {
		const src = read(common);
		const decAt = src.indexOf('sys.modules["dependency_existence_check"]');
		const sibAt = Math.min(
			src.search(/^from \._routes import /m),
			src.search(/^from \._fakes import /m),
		);
		assert.ok(decAt > -1, "the shim must register the production module");
		assert.ok(sibAt > decAt, "`dec` must exist before a sibling imports it back");
		assert.ok(src.indexOf("OLD_ISO = ") < sibAt, "`OLD_ISO` must exist before `_routes`");
	});

	it("keeps `_routes.py` free of the fake and of almost all of the barrel", () => {
		const src = read(routes);
		assert.doesNotMatch(src, /\b_fakes\b/, "_routes must not touch the transport fake");
		const imported = [...src.matchAll(/^from \._common import (.+)$/gm)].flatMap((m) =>
			m[1]!
				.replace(/[()]/g, "")
				.split(",")
				.map((s) => s.trim()),
		);
		assert.deepEqual(imported.sort(), ["OLD_ISO"], "only OLD_ISO comes back from the barrel");
		assert.doesNotMatch(src, /^from \._routes import /m, "_routes imports itself");
	});

	it("imports `dec` into `_fakes.py` and nothing circular", () => {
		const src = read(fakes);
		assert.match(src, /^from \._common import .*\bdec\b/m);
		assert.doesNotMatch(src, /^from \._common import \*/m);
		assert.doesNotMatch(src, /^from \._fakes import /m, "_fakes imports itself");
	});

	it("leaves every member of the family under the ceiling", () => {
		for (const rel of [common, routes, fakes]) {
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
			assert.equal(flagged(rel), false, `${rel} is still flagged`);
		}
	});

	it("keeps the runtime working: the python suite still discovers 62 tests", () => {
		// `unittest` exits 0 with a zero-match pattern, so the test count is the
		// guard: a broken shim, a lost star-import or an unregistered `dec`
		// shows up as an error or a smaller run, never as a silent pass.
		const run = spawnSync("python3", ["test/dependency-existence-check.test.py"], {
			cwd: ROOT,
			encoding: "utf-8",
		});
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		assert.equal(run.status, 0, `python suite exited ${run.status}: ${output}`);
		assert.match(output, /Ran 62 tests/);
		assert.match(output, /^OK$/m);
	});
});

// ─── Phase 3: `test_pipeline_age_guard.py` split ─────────────────

describe("god-object refactor #2034 — the age-guard scenario family", () => {
	const AGES = [
		"test_age_guard_boundary",
		"test_exempt_young_allows_specific_version_below_threshold",
		"test_exempt_young_rejects_malformed_spec",
		"test_days_since_floor_semantics",
		"test_age_guard_skipped_for_date_less_registries",
		"test_missing_date_fail_closed",
	];
	const CLI = [
		"test_cli_usage_errors_exit_2",
		"test_json_report_contract",
		"test_threshold_override",
		"test_no_manifests_exit_zero",
		"test_verbose_does_not_change_json_or_exit_code",
		"test_cross_manifest_dedupe_one_request",
	];
	const SCENARIOS: Record<string, { cls: string; tests: string[] }> = {
		[`${GC}/test_pipeline_age_guard.py`]: { cls: "PipelineAndAgeGuardTests", tests: AGES },
		[`${GC}/test_cli_report_contract.py`]: { cls: "CliReportContractTests", tests: CLI },
	};

	it("puts each scenario in the module that owns it", () => {
		for (const [rel, spec] of Object.entries(SCENARIOS)) {
			const src = read(rel);
			assert.match(src, new RegExp(`^class ${spec.cls}\\(`, "m"), `${rel}: ${spec.cls}`);
			for (const t of spec.tests) {
				assert.match(src, new RegExp(`^\\s+def ${t}\\(`, "m"), `${rel} lost ${t}`);
			}
		}
	});

	it("preserves all 12 test names exactly once across the family", () => {
		const src = [GC + "/test_pipeline_age_guard.py", GC + "/test_cli_report_contract.py"]
			.map(read)
			.join("\n");
		const names = [...src.matchAll(/^\s+def (test_\w+)\(/gm)].map((m) => m[1]!);
		assert.deepEqual([...names].sort(), [...[...AGES, ...CLI]].sort());
	});

	it("hoists the shared lifecycle into `PipelineGuardBase`", () => {
		const bases = read(`${GC}/_bases.py`);
		assert.match(bases, /^class PipelineGuardBase\(unittest\.TestCase\):/m);
		for (const member of ["setUp", "tearDown", "_run_py_dep"]) {
			assert.match(bases, new RegExp(`^    def ${member}\\(`, "m"), `_bases lost ${member}`);
		}
		for (const spec of Object.values(SCENARIOS)) {
			const src = read(Object.keys(SCENARIOS).find((r) => read(r).includes(spec.cls))!);
			assert.match(
				src,
				new RegExp(`^class ${spec.cls}\\(PipelineGuardBase\\):`, "m"),
				`${spec.cls} must subclass PipelineGuardBase`,
			);
			assert.doesNotMatch(src, /^\s+def (setUp|tearDown)\(/m, `${spec.cls} redeclares lifecycle`);
		}
	});

	it("leaves `_bases.py` and every scenario module under the ceiling", () => {
		for (const rel of [
			`${GC}/_bases.py`,
			`${GC}/test_pipeline_age_guard.py`,
			`${GC}/test_cli_report_contract.py`,
		]) {
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
			assert.equal(flagged(rel), false, `${rel} is still flagged`);
		}
	});

	it("keeps the untouched harness bases in `_bases.py`", () => {
		const bases = read(`${GC}/_bases.py`);
		for (const cls of ["AdapterExtractionBase", "RegistryIntervalBase"]) {
			assert.match(bases, new RegExp(`^class ${cls}\\(unittest\\.TestCase\\):`, "m"));
		}
	});

	it("cannot silently skip the new scenarios: the runner imports them", () => {
		const runner = read("test/dependency-existence-check.test.py");
		const stmt =
			/^from dependency_existence_check_tests\.test_cli_report_contract import \([^)]*\)/m.exec(
				runner,
			)?.[0] ?? "";
		assert.match(stmt, /\bCliReportContractTests\b/, "the runner must import the new class");
	});

	it("is acyclic: no scenario module imports a sibling scenario module", () => {
		for (const rel of Object.keys(SCENARIOS)) {
			const src = read(rel);
			assert.doesNotMatch(src, /from \.test_\w+ import/, `${rel} imports a scenario sibling`);
		}
	});
});

// ─── Phase 4: the `disk_space_test.go` split ─────────────────────

describe("god-object refactor #2034 — the Go disk-space family", () => {
	const KEEP = "cmd/cheasee-pi/disk_space_test.go";
	const STUB = "cmd/cheasee-pi/disk_space_stub_test.go";
	const COMPOSE = "cmd/cheasee-pi/disk_space_compose_test.go";

	it("moves whole declarations: the family still counts 26", () => {
		const sum = [KEEP, STUB, COMPOSE].reduce((n, rel) => n + count(rel), 0);
		assert.equal(sum, BASE_COUNT[KEEP], `family counts ${sum}`);
	});

	it("preserves the base `func` name-set exactly (25 names)", () => {
		const base = [
			"stubDockerInfoRoot",
			"stubStatfs",
			"stubStatfsAmple",
			"stubStatfsBytes",
			"recordCompose",
			"TestCheckBuildDiskSpace_AboveThreshold_NoError",
			"TestCheckBuildDiskSpace_AtThreshold_NoError",
			"TestCheckBuildDiskSpace_BelowThreshold_ActionableError",
			"TestCheckBuildDiskSpace_ZeroFree_Refuses",
			"TestCheckBuildDiskSpace_StatfsError_FailsOpen",
			"TestCheckBuildDiskSpace_DataRootError_FailsOpen",
			"TestCheckBuildDiskSpace_EmptyDataRoot_FailsOpen",
			"TestDockerDataRoot_TrimsWhitespace",
			"TestDockerDataRoot_StatfsReceivesResolvedPath",
			"TestMinBuildFreeBytes_DocumentedThreshold",
			"TestComposeBuild_LowDiskRefusedBeforeRun",
			"TestComposeBuild_LowDiskErrorNotWrapped",
			"TestComposeBuild_AmpleDisk_OneComposeInvocation",
			"TestRunBuildE_LowDisk_NoCompose",
			"TestRunRebuildE_LowDisk_NoComposeNoPrune",
			"TestRunBuildE_LowDiskRefusedWithNoDockerCheck",
			"TestDockerComposeUp_LowDiskRefusesBeforeCompose",
			"TestPlatformFreeBytes_TempDir",
			"TestInstallationDoc_BuildDisk",
			"TestCLIDoc_BuildDisk",
		];
		const now = [KEEP, STUB, COMPOSE].flatMap((rel) => goDecls(read(rel)));
		assert.deepEqual([...now].sort(), [...base].sort());
	});

	it("keeps the scenario families in the file that owns them", () => {
		assert.deepEqual(goDecls(read(STUB)).sort(), [
			"recordCompose",
			"stubDockerInfoRoot",
			"stubStatfs",
			"stubStatfsAmple",
			"stubStatfsBytes",
		]);
		for (const name of goDecls(read(COMPOSE))) {
			assert.match(name, /^Test(ComposeBuild|RunBuildE|RunRebuildE|DockerComposeUp)_/);
		}
		for (const name of goDecls(read(KEEP))) {
			assert.match(
				name,
				/^Test(CheckBuildDiskSpace|DockerDataRoot|MinBuildFreeBytes|PlatformFreeBytes|InstallationDoc|CLIDoc)_?/,
				`${name} does not belong in the policy adapter`,
			);
		}
	});

	it("stays in package main and under the ceiling", () => {
		for (const rel of [KEEP, STUB, COMPOSE]) {
			assert.ok(rel.endsWith("_test.go"), `${rel} is not a test file`);
			assert.match(read(rel), /^package main$/m, `${rel} left package main`);
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
			assert.equal(flagged(rel), false, `${rel} is still flagged`);
		}
	});
});

// ─── Phase 5: envelope — the metric actually falls ────────────────

describe("god-object refactor #2034 — the metric falls", () => {
	it("drops exactly the split families", () => {
		const b = baseline();
		assert.equal(
			b.after.godObjectCount,
			b.before.godObjectCount - (b.reducedBy.length + UNCITED_REDUCED.length),
			"after != before - split families",
		);
		assert.equal(b.after.godObjectCount, 21);
	});

	it("records every still-flagged file as a deferral", () => {
		const b = baseline();
		const deferred = b.deferred.flatMap((d) => d.files);
		assert.equal(deferred.length, b.after.godObjectCount, "deferred total != after count");
		for (const rel of deferred) {
			assert.ok(exists(rel), `deferred path is missing: ${rel}`);
			assert.equal(flagged(rel), true, `${rel} is deferred but not flagged — a fiction`);
		}
	});

	it("carries reason and requires on every deferral", () => {
		for (const group of baseline().deferred) {
			assert.ok(group.reason.trim().length > 0, "a deferral needs a reason");
			assert.ok(group.requires.trim().length > 0, "a deferral needs what unblocks it");
		}
	});

	it("actually reduced every `reducedBy` file", () => {
		for (const rel of [...baseline().reducedBy, ...UNCITED_REDUCED]) {
			assert.equal(flagged(rel), false, `${rel} is claimed reduced but still flagged`);
		}
	});

	it("matches the live tree: no extra flags, no missing deferrals", () => {
		const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
			.trim()
			.split("\n");
		const live = files.filter((rel) => {
			if (!CODE_EXTS.includes(`.${ext(rel)}`)) return false;
			return exists(rel) && flagged(rel);
		});
		const b = baseline();
		assert.ok(
			live.length <= b.after.godObjectCount,
			`live flagged ${live.length} > recorded ${b.after.godObjectCount}`,
		);
		for (const rel of [...b.reducedBy, ...UNCITED_REDUCED]) {
			assert.equal(live.includes(rel), false, `${rel} is still flagged in the live tree`);
		}
		for (const rel of b.deferred.flatMap((d) => d.files)) {
			assert.ok(live.includes(rel), `${rel} is deferred but not flagged in the live tree`);
		}
	});

	it("keeps the baseline and the uncited reduction disjoint and complete", () => {
		const b = baseline();
		assert.deepEqual(
			[...b.reducedBy].sort(),
			[`${GC}/_common.py`, `${GC}/test_pipeline_age_guard.py`],
			"baseline.reducedBy must list exactly the cited reductions",
		);
		assert.deepEqual(UNCITED_REDUCED, ["cmd/cheasee-pi/disk_space_test.go"]);
		for (const rel of UNCITED_REDUCED) {
			assert.equal(b.reducedBy.includes(rel), false, `${rel} is both cited and uncited`);
			assert.equal(FILED.includes(rel), false, `${rel} is cited, so it is not uncited`);
		}
	});

	it("TOUCHED covers exactly the 3 reduction sources", () => {
		const b = baseline();
		assert.deepEqual([...Object.keys(TOUCHED)].sort(), [...b.reducedBy, ...UNCITED_REDUCED].sort());
	});

	it("every touched family and sibling exists once and stays under the ceiling", () => {
		assert.equal(new Set(FAMILY).size, FAMILY.length, "a family member is listed twice");
		for (const rel of FAMILY) {
			assert.ok(exists(rel), `missing family file: ${rel}`);
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
		}
	});
});
