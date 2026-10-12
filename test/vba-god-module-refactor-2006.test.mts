// ─── VBA-god-module refactor contract (issue #2006) ───────────────
// CodeFlow's `VBA God Module` metric is not a VBA detector: the pinned analyzer
// (`index.html` `detectPatterns`, ref below) emits it as
//   vbaGodFiles = files.filter(f => f.isCode !== false && f.functions.length > 20)
// the *same* predicate behind `God Object`, at a higher ceiling. It is a raw
// text parser count, so a split only moves the metric when every sibling lands
// `<= 20`; this change targets `<= 15` so no sibling mints a God Object.
//
// The mirror (`test/fixtures/function-count-mirror.mts`) reproduces the pinned
// detector; the recorded measurement (`test/fixtures/vba-god-module-baseline.json`)
// holds the external run over two `git archive` snapshots and only the 2 Python
// modules verifiable in this image are split — the 16 `.rs` files and
// `server.py` are measured and deferred.
//
// Run: node --experimental-strip-types --test test/vba-god-module-refactor-2006.test.mts

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
const DIR = "test/dependency_existence_check_tests/";

/** Family -> siblings landed. `_bases.py` is shared, so it is listed twice. */
const TOUCHED: Record<string, string[]> = {
	"test_adapter_extraction.py": [
		"test_adapter_extraction_jvm_dotnet.py",
		"test_adapter_extraction_systems_dynamic.py",
		"_bases.py",
	],
	"test_registry_transport.py": [
		"test_registry_transport_cache.py",
		"test_registry_transport_registries.py",
		"_bases.py",
	],
};

const SHARED = "_bases.py";
const ADAPTER = [
	"test_adapter_extraction.py",
	"test_adapter_extraction_jvm_dotnet.py",
	"test_adapter_extraction_systems_dynamic.py",
];
const REGISTRY = [
	"test_registry_transport.py",
	"test_registry_transport_cache.py",
	"test_registry_transport_registries.py",
];

/** The class contract and the test methods each module holds, verbatim. */
const SCENARIOS: Record<string, { cls: string; tests: string[] }[]> = {
	"_bases.py": [
		{ cls: "AdapterExtractionBase", tests: [] },
		{ cls: "RegistryIntervalBase", tests: [] },
	],
	"test_adapter_extraction.py": [
		{
			cls: "AdapterExtractionTests",
			tests: [
				"test_python_requirements",
				"test_python_pyproject_and_poetry",
				"test_python_pipfile",
				"test_python_setup_cfg_and_setup_py",
				"test_js_package_json_sections_and_scoped_names",
				"test_go_mod",
			],
		},
	],
	"test_adapter_extraction_jvm_dotnet.py": [
		{
			cls: "AdapterExtractionJvmDotnetTests",
			tests: [
				"test_java_pom_xml",
				"test_java_gradle",
				"test_dotnet_csproj_packages_config_and_central",
			],
		},
	],
	"test_adapter_extraction_systems_dynamic.py": [
		{
			cls: "AdapterExtractionSystemsDynamicTests",
			tests: [
				"test_rust_cargo_toml_and_lock",
				"test_rust_cargo_lock_skips_own_crate",
				"test_cpp_vcpkg_and_conan",
				"test_ruby_gemfile_lock_and_gemspec",
				"test_php_composer",
				"test_swift_package",
				"test_dart_pubspec",
			],
		},
	],
	"test_registry_transport.py": [
		{
			cls: "RegistryAndTransportTests",
			tests: [
				"test_registry_url_construction",
				"test_maven_two_requests",
				"test_pypi_name_normalization",
				"test_404_is_not_found",
			],
		},
	],
	"test_registry_transport_cache.py": [
		{
			cls: "RegistryTransportCacheTests",
			tests: [
				"test_5xx_retries_then_unreachable",
				"test_network_error_recoverable_per_package",
				"test_etag_cache_flow_and_persistence",
				"test_cache_dir_persists_across_two_runs",
				"test_user_agent_sent_on_every_request",
				"test_rate_limiting_same_registry_spaced",
				"test_rate_limiting_different_registries_not_cross_throttled",
			],
		},
	],
	"test_registry_transport_registries.py": [
		{
			cls: "RegistryTransportRegistriesTests",
			tests: ["test_packagist_missing_vendor_no_crash", "test_nuget_case_insensitive_id"],
		},
	],
};

const RAW = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];
const MODULES = [...new Set(RAW)];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const missingPaths = (paths: string[]): string[] =>
	paths.filter((rel) => !existsSync(resolve(ROOT, rel)));
const overlap = (a: string[], b: string[]): string[] => a.filter((rel) => b.includes(rel));

const VBA_BASELINE = JSON.parse(read("test/fixtures/vba-god-module-baseline.json")) as {
	provenance: {
		issue: number;
		title: string;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; vbaGodModuleCount: number };
	after: { commit: string; files: number; vbaGodModuleCount: number };
	tradeoffs: Record<string, string>;
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

// ─── The mirror mirrors the pinned detector ───────────────────────

describe("vba god module refactor #2006 — the mirror is the pinned detector", () => {
	const mk = (n: number): string =>
		Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join("\n");

	it("pins the 40-hex analyzer ref", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
	});

	it("has teeth at the vba boundary (strictly more than 20)", () => {
		assert.equal(countFunctions(mk(20), "ts"), 20);
		assert.equal(functionCountFlagged(mk(20), "x.ts", 20), false, "20 must not be flagged");
		assert.equal(countFunctions(mk(21), "ts"), 21);
		assert.equal(functionCountFlagged(mk(21), "x.ts", 20), true, "21 must be flagged");
	});

	it("has teeth at the god-object boundary (strictly more than 15)", () => {
		assert.equal(functionCountFlagged(mk(15), "x.ts", 15), false, "15 must not be flagged");
		assert.equal(functionCountFlagged(mk(16), "x.ts", 15), true, "16 must be flagged");
	});

	it("gates non-code extensions out but scores the same text as `.ts`", () => {
		const src = mk(30);
		for (const rel of ["sample.mts", "sample.json", "sample.md"]) {
			assert.equal(functionCountFlagged(src, rel, 20), false, `${rel} is never scored`);
		}
		assert.equal(CODE_EXTS.includes(".mts"), false, "`.mts` is not a code ext");
		assert.equal(functionCountFlagged(src, "sample.ts", 20), true, "the same text as .ts is");
	});

	it("is not vacuous", () => {
		assert.equal(countFunctions("", "ts"), 0);
		assert.equal(functionCountFlagged("", "x.ts", 20), false);
	});

	it("counts `.py` class lines, top-level and nested `def`s, deduped by name@line", () => {
		const src = [
			"class C:",
			"    def outer(self):",
			"        def inner():",
			"            pass",
			"def free():",
			"    pass",
		].join("\n");
		assert.equal(countFunctions(src, "py"), 4, "class + outer + inner + free");
		// Same name on two lines is two declarations; the same line twice is one.
		assert.equal(countFunctions("def f():\n    pass\ndef f():\n    pass\n", "py"), 2);
	});

	it("runs the cross-language RULES pass over `.go` in addition to GO_RULE", () => {
		const src = "func TestOne(t *testing.T) {\n\tif err != nil {\n\t}\n}\n";
		assert.equal(countFunctions(src, "go"), 1, "the shared RULES pass re-adds the same name@line");
		assert.equal(countFunctions("func TestOne(t *testing.T) {}\nfunc TestTwo(t *testing.T) {}\n", "go"), 2);
	});
});

// ─── Manifest ─────────────────────────────────────────────────────

describe("vba god module refactor #2006 — manifest", () => {
	it("lists the two split families, each with siblings and the shared base once", () => {
		assert.deepStrictEqual(Object.keys(TOUCHED).sort(), [
			"test_adapter_extraction.py",
			"test_registry_transport.py",
		]);
		assert.equal(RAW.filter((m) => m === SHARED).length, 2, "_bases.py is shared by both families");
		assert.equal(new Set(RAW).size, RAW.length - 1, "only the shared base may repeat");
	});

	it("every listed module exists and is never a `.mts`", () => {
		for (const mod of MODULES) {
			assert.ok(existsSync(resolve(ROOT, DIR + mod)), `missing manifest module: ${DIR}${mod}`);
			assert.ok(!mod.endsWith(".mts"), `${mod} is never scored by the analyzer`);
		}
	});

	it("preserves every test name exactly once, across both families", () => {
		const names = MODULES.flatMap((m) => SCENARIOS[m]!.flatMap((s) => s.tests));
		assert.equal(new Set(names).size, names.length, "a test name is declared twice");
		const of = (family: string[]): number =>
			family.reduce((n, m) => n + SCENARIOS[m]!.flatMap((s) => s.tests).length, 0);
		assert.equal(of(ADAPTER), 16, "the adapter family keeps its 16 tests");
		assert.equal(of(REGISTRY), 13, "the registry family keeps its 13 tests");
	});

	it("keeps the five nested helpers in the cache sibling", () => {
		const src = read(DIR + "test_registry_transport_cache.py");
		assert.match(src, /def flaky\(/);
		assert.match(src, /def boom\(/);
		assert.equal(src.match(/\bdef opener\b/g)?.length, 3);
	});

	it("is acyclic: no scenario module imports a sibling or the family it was split from", () => {
		for (const mod of MODULES) {
			if (!mod.startsWith("test_")) continue;
			const src = read(DIR + mod);
			assert.doesNotMatch(
				src,
				/from\s+\.\s*test_\w+\s+import/,
				`${mod} imports a sibling scenario module`,
			);
			for (const origin of Object.keys(TOUCHED)) {
				const stem = origin.replace(/\.py$/, "");
				assert.doesNotMatch(
					src,
					new RegExp(`from\\s+\\.\\s*${stem}\\s+import`),
					`${mod} imports the module it was split from`,
				);
			}
		}
	});

	it("registers every scenario class in the thin entry", () => {
		const entry = read("test/dependency-existence-check.test.py");
		for (const mod of MODULES) {
			for (const { cls } of SCENARIOS[mod]!) {
				if (cls.endsWith("Base")) continue;
				assert.match(
					entry,
					new RegExp(`from dependency_existence_check_tests\\.${mod.replace(/\.py$/, "")} import`),
					`the entry must import from ${mod}`,
				);
				assert.ok(new RegExp(`\\b${cls}\\b`).test(entry), `the entry must import ${cls}`);
			}
		}
	});
});

// ─── The invariant that makes the metric fall ─────────────────────

describe("vba god module refactor #2006 — every split module is under both ceilings", () => {
	for (const mod of MODULES) {
		it(`${DIR}${mod} counts <= 15 and is not flagged at 20 either`, () => {
			const src = read(DIR + mod);
			assert.equal(
				functionCountFlagged(src, DIR + mod, 20),
				false,
				`${mod} is still a VBA god module`,
			);
			assert.equal(
				functionCountFlagged(src, DIR + mod, 15),
				false,
				`${mod} mints a God Object regression`,
			);
			for (const { cls, tests } of SCENARIOS[mod]!) {
				assert.match(src, new RegExp(`^class ${cls}\\b`, "m"), `${mod} must declare ${cls}`);
				for (const t of tests) {
					assert.match(src, new RegExp(`\\bdef ${t}\\b`), `${mod} must declare ${t}`);
				}
			}
		});
	}
});

// ─── Recorded envelope ────────────────────────────────────────────

describe("vba god module refactor #2006 — recorded envelope", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(VBA_BASELINE.provenance.issue, 2006);
		assert.strictEqual(VBA_BASELINE.provenance.title, "VBA God Module");
		assert.strictEqual(VBA_BASELINE.provenance.filedCount, 44, "the issue's filed count");
		assert.strictEqual(VBA_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(VBA_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(VBA_BASELINE.provenance.metric, /functions/, "the metric names the parser count");
		assert.match(
			VBA_BASELINE.provenance.metric,
			/functions\.length > 20/,
			"the metric names the exact predicate",
		);
		assert.match(
			VBA_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		for (const [side, ref] of [
			["before", VBA_BASELINE.before],
			["after", VBA_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			VBA_BASELINE.after.commit,
			VBA_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			VBA_BASELINE.after.vbaGodModuleCount < VBA_BASELINE.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			VBA_BASELINE.after.files > VBA_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.deepStrictEqual(
			[...VBA_BASELINE.reducedBy].sort(),
			[DIR + "test_adapter_extraction.py", DIR + "test_registry_transport.py"].sort(),
			"reducedBy is exactly the two Python originals this change splits",
		);
		for (const rel of VBA_BASELINE.reducedBy) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is test-only: the analyzer never scores it`);
			assert.ok(MODULES.includes(rel.replace(DIR, "")), `${rel} must be a split family`);
		}
	});

	it("defers the 16 Rust files and server.py with reasons, all existing", () => {
		const deferred = VBA_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and server.py deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const files = deferred.flatMap((d) => d.files ?? []);
		assert.deepStrictEqual(missingPaths(files), [], "a deferred path does not exist");
		const rust = deferred.find((d) => (d.files ?? []).length > 0 && d.files!.every((f) => f.endsWith(".rs")));
		const serverPy = deferred.find((d) => (d.files ?? []).includes("cmd/cheasee-pi/embedded/docker/codeflow/server.py"));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(serverPy, "the embedded server.py is recorded as deferred");
		assert.equal(rust.files!.length, 16, "the whole measured Rust set is deferred");
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		const files = VBA_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.equal(
			VBA_BASELINE.before.vbaGodModuleCount,
			VBA_BASELINE.reducedBy.length + files.length,
			"base count must equal reduced + deferred",
		);
		assert.equal(
			VBA_BASELINE.after.vbaGodModuleCount,
			files.length,
			"every file still flagged is a deferred one",
		);
		assert.equal(VBA_BASELINE.reducedBy.length, Object.keys(TOUCHED).length, "one reduction source per split family");
	});

	it("fails closed on a missing or doubly-cited path", () => {
		// Teeth: the detectors report what they are handed before being trusted.
		assert.deepStrictEqual(missingPaths(["test/fixtures/vba-god-module-baseline.json"]), []);
		assert.deepStrictEqual(missingPaths([DIR + "no-such-sibling-2006.py"]), [
			DIR + "no-such-sibling-2006.py",
		]);
		assert.deepStrictEqual(overlap(["a.py", "b.py"], ["b.py"]), ["b.py"]);
		const files = VBA_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.deepStrictEqual(
			overlap(VBA_BASELINE.reducedBy, files),
			[],
			"no path is both a reduction source and a deferral",
		);
	});
});
