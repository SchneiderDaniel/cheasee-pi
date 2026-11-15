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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
	/** Ledger paths the tree no longer carries (overlay: the filed set keeps them). */
	removed: { path: string; issue: number; reason: string }[];
	/** Files a later issue split below the ceiling, cited under that issue. */
	reducedByLater?: { issue: number; reason: string; files: string[] };
	deferred: { reason: string; requires: string; files: string[] }[];
	notScored: { reason: string; files: string[] }[];
	/** Files a later issue split below the ceiling without citing this one. */
	laterReduced?: { issue: number; reason: string; files: string[] };
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

/** `_common.py` -> `_common`: the module name a relative import resolves to. */
const mod = (rel: string): string => rel.split("/").pop()!.replace(/\.py$/, "");

/** Distinct top-level relative-import edges (`from ._x import ...`) of a module. */
const pyEdges = (rel: string): string[] => [
	...new Set([...read(rel).matchAll(/^from \.(\w+) import/gm)].map((m) => m[1]!)),
];

/** First cycle in a module graph as a closed path (`[...a, a]`), or `[]`.
 * Colour DFS over every node, including ones no other node reaches: a cycle
 * cannot hide behind an unreferenced entry point. */
const findCycle = (graph: Record<string, string[]>): string[] => {
	const GREY = 1;
	const BLACK = 2;
	const colour = new Map<string, number>();
	const stack: string[] = [];
	const visit = (node: string): string[] => {
		colour.set(node, GREY);
		stack.push(node);
		for (const next of graph[node] ?? []) {
			if (colour.get(next) === GREY) return [...stack.slice(stack.indexOf(next)), next];
			if (colour.get(next) === undefined) {
				const found = visit(next);
				if (found.length > 0) return found;
			}
		}
		stack.pop();
		colour.set(node, BLACK);
		return [];
	};
	for (const node of Object.keys(graph)) {
		if (colour.get(node) === undefined) {
			const found = visit(node);
			if (found.length > 0) return found;
		}
	}
	return [];
};

/** Every module of the Python harness package, measured from disk. */
const packageModules = (): string[] =>
	readdirSync(resolve(ROOT, GC))
		.filter((n) => n.endsWith(".py"))
		.sort()
		.map((n) => `${GC}/${n}`);

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
		const removed = b.removed.map((r) => r.path);
		const partition = [
			...b.reducedBy,
			...(b.reducedByLater?.files ?? []),
			...b.deferred.flatMap((d) => d.files),
			...b.notScored.flatMap((n) => n.files),
			...removed,
		];
		assert.equal(new Set(partition).size, partition.length, "a path is listed twice");
		assert.deepEqual([...partition].sort(), [...FILED].sort(), "partition != filed list");
		for (const rel of FILED) {
			assert.ok(exists(rel) || removed.includes(rel), `filed path is missing: ${rel}`);
		}
	});

	it("every removed path is absent from the tree and records why", () => {
		for (const entry of baseline().removed) {
			assert.equal(entry.issue, 2072, `${entry.path} records its removing issue`);
			assert.ok(entry.reason.trim().length > 0, `${entry.path} records a reason`);
			assert.equal(exists(entry.path), false, `${entry.path} is recorded as removed`);
		}
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
		assert.equal(deferred.size, 20);
		assert.equal(notScored.size, 19);
		assert.equal(b.removed.length, 1, "the caveman suite is the one removed ledger path");
		// #2031 split `server.py` below the ceiling; it is cited under that issue.
		assert.deepEqual(b.reducedByLater?.files, [
			"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
		]);
		assert.equal(b.reducedByLater?.issue, 2031);
		assert.equal(deferred.has(b.reducedByLater!.files[0]!), false, "server.py is still deferred");
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

// ─── Phase 2: `_common.py` -> barrel + `_loader.py` + `_routes.py` + `_fakes.py` ─

describe("god-object refactor #2034 — the Python harness family", () => {
	const loader = `${GC}/_loader.py`;
	const common = `${GC}/_common.py`;
	const routes = `${GC}/_routes.py`;
	const fakes = `${GC}/_fakes.py`;
	const MEMBERS = [loader, common, routes, fakes];

	it("moves whole declarations: the family still counts 16", () => {
		const sum = MEMBERS.reduce((n, rel) => n + count(rel), 0);
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
		const now = MEMBERS.flatMap((rel) => pyDecls(read(rel)));
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

	it("re-exports all three leaves explicitly — no wildcard propagation", () => {
		const src = read(common);
		assert.doesNotMatch(src, /^from \._\w+ import \*$/m, "no wildcard re-export");
		for (const leaf of ["_loader", "_routes", "_fakes"]) {
			const hits = src.match(new RegExp(`^from \\.${leaf} import `, "gm")) ?? [];
			assert.equal(hits.length, 1, `the barrel must re-export ${leaf} exactly once`);
		}
	});

	it("makes `_common.py` a pure barrel: no shim, no shared fact", () => {
		const src = read(common);
		for (const logic of ["spec_from_file_location", "exec_module", "sys\\.modules\\["]) {
			assert.doesNotMatch(src, new RegExp(logic), `the barrel still runs ${logic}`);
		}
		assert.doesNotMatch(src, /^OLD_ISO = /m, "`OLD_ISO` belongs to `_routes`, not the barrel");
		assert.doesNotMatch(src, /importlib shim lives here/, "stale shim wording in the barrel");
		assert.deepEqual(pyEdges(common).sort(), ["_fakes", "_loader", "_routes"]);
	});

	it("orders the barrel leaf-first: the loader, then the siblings", () => {
		const src = read(common);
		const at = (p: string): number => src.search(new RegExp(`^from \\.${p} import `, "m"));
		assert.ok(at("_loader") > -1, "the barrel must import the leaf");
		assert.ok(at("_loader") < at("_routes"), "`_loader` must come before `_routes`");
		assert.ok(at("_loader") < at("_fakes"), "`_loader` must come before `_fakes`");
	});

	it("keeps `_loader.py` the leaf that owns the production-module load", () => {
		const src = read(loader);
		assert.deepEqual(pyEdges(loader), [], "`_loader` must not import a sibling");
		assert.doesNotMatch(src, /^import \._/m, "`_loader` must not import a sibling");
		for (const sym of ["dec", "_HERE", "_SCRIPTS"]) {
			assert.match(src, new RegExp(`^${sym} = `, "m"), `_loader must bind ${sym}`);
		}
		assert.match(src, /^_HERE = Path\(__file__\)\.resolve\(\)\.parent\.parent$/m);
		assert.match(src, /^_SCRIPTS = _HERE\.parent \/ "scripts"$/m);
		const reg = src.indexOf('sys.modules["dependency_existence_check"] = dec');
		assert.ok(reg > -1, "`_loader` must register the production module");
		assert.ok(reg < src.indexOf(".exec_module(dec)"), "register before `exec_module`");
		for (const guard of [
			"scripts/dependency-existence-check.py must exist",
			"must have a loader",
		]) {
			assert.ok(src.includes(guard), `_loader lost its guard: ${guard}`);
		}
		assert.deepEqual(pyDecls(src), [], "`_loader` declares nothing, so the family stays at 16");
	});

	it("imports `_loader` standalone in a fresh interpreter", () => {
		const run = spawnSync(
			"python3",
			[
				"-c",
				"import dependency_existence_check_tests._loader as L; " +
					"assert L.dec.main; assert L._SCRIPTS.is_dir(); print('ok')",
			],
			{ cwd: ROOT, encoding: "utf-8", env: { ...process.env, PYTHONPATH: "test" } },
		);
		assert.equal(run.status, 0, `leaf import failed: ${run.stdout}${run.stderr}`);
		assert.equal(run.stdout.trim(), "ok");
	});

	it("keeps `_routes.py` a leaf that owns `OLD_ISO`", () => {
		const src = read(routes);
		assert.deepEqual(pyEdges(routes), [], "`_routes` must not import any sibling");
		assert.match(src, /^OLD_ISO = "2020-01-01T00:00:00Z"/m, "`_routes` owns OLD_ISO");
		assert.doesNotMatch(src, /\b_fakes\b/, "_routes must not touch the transport fake");
		const uses = src.match(/\bOLD_ISO\b/g) ?? [];
		assert.ok(uses.length >= 7, `OLD_ISO must resolve locally, saw ${uses.length} uses`);
	});

	it("imports `_routes` standalone in a fresh interpreter", () => {
		const run = spawnSync(
			"python3",
			[
				"-c",
				"import dependency_existence_check_tests._routes as R; " +
					"assert R.OLD_ISO == '2020-01-01T00:00:00Z'; " +
					"assert R.pypi_body().count(R.OLD_ISO) == 1; print('ok')",
			],
			{ cwd: ROOT, encoding: "utf-8", env: { ...process.env, PYTHONPATH: "test" } },
		);
		assert.equal(run.status, 0, `leaf import failed: ${run.stdout}${run.stderr}`);
		assert.equal(run.stdout.trim(), "ok");
	});

	it("imports `dec` into `_fakes.py` from the leaf, not the barrel", () => {
		const src = read(fakes);
		assert.match(src, /^from \._loader import .*\bdec\b/m);
		assert.doesNotMatch(src, /^from \._common import/m, "`_fakes` must not reach into the barrel");
		assert.deepEqual(pyEdges(fakes), ["_loader"], "`_fakes` depends on the leaf only");
		for (const decl of ["FakeFetcher", "run_main", "write_repo"]) {
			assert.match(src, new RegExp(`^(class|def) ${decl}\\b`, "m"), `_fakes lost ${decl}`);
		}
	});

	it("leaves every member of the family under the ceiling", () => {
		for (const rel of MEMBERS) {
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
			assert.equal(flagged(rel), false, `${rel} is still flagged`);
		}
	});

	it("keeps the runtime working: the python suite still discovers 77 tests", () => {
		// `unittest` exits 0 with a zero-match pattern, so the test count is the
		// guard: a broken shim, a lost star-import or an unregistered `dec`
		// shows up as an error or a smaller run, never as a silent pass. The
		// count is 62 from #2034 plus the 15 discovery/verify stage tests
		// registered by #2103 (18 before the verify cases were folded into
		// table-driven subtests to stay under the function-count ceiling).
		const run = spawnSync("python3", ["test/dependency-existence-check.test.py"], {
			cwd: ROOT,
			encoding: "utf-8",
		});
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		assert.equal(run.status, 0, `python suite exited ${run.status}: ${output}`);
		assert.match(output, /Ran 77 tests/);
		assert.match(output, /^OK$/m);
	});
});

// ─── Phase 2b: the family import graph is acyclic (issue #2104) ───
// CodeFlow reported `_common ↔ _routes` and `_common ↔ _fakes` as circular
// dependencies. Both were real module-level edges: the barrel defined `dec`
// and `OLD_ISO` and then imported the siblings, which imported those facts
// back. The family is now `_loader` (leaf) <- `_fakes` <- `_common` (barrel)
// with `_routes` a leaf, and the DFS below is the guard that keeps it so — it
// replaces the assertions that used to pin the cycle as a contract.

describe("god-object refactor #2034 — the harness import graph is acyclic", () => {
	const loader = `${GC}/_loader.py`;
	const common = `${GC}/_common.py`;
	const routes = `${GC}/_routes.py`;
	const fakes = `${GC}/_fakes.py`;
	const bases = `${GC}/_bases.py`;

	it("pins the exact edge map: barrel -> leaves, fakes -> loader", () => {
		const graph = Object.fromEntries(
			[loader, routes, fakes, common, bases].map((rel) => [mod(rel), pyEdges(rel).sort()]),
		);
		assert.deepEqual(graph, {
			_loader: [],
			_routes: [],
			_fakes: ["_loader"],
			_common: ["_fakes", "_loader", "_routes"],
			_bases: ["_common"],
		});
	});

	it("reports no cycle anywhere in the package", () => {
		const graph = Object.fromEntries(packageModules().map((rel) => [mod(rel), pyEdges(rel)]));
		const cycle = findCycle(graph);
		assert.deepEqual(cycle, [], `circular dependency: ${cycle.join(" -> ")}`);
	});

	it("has teeth: the pre-fix graph is detected as circular", () => {
		const cycle = findCycle({
			_common: ["_routes", "_fakes"],
			_routes: ["_common"],
			_fakes: ["_common"],
		});
		assert.ok(cycle.length > 1, "the detector must find a cycle in the pre-fix graph");
		assert.ok(cycle.includes("_common"), `unexpected cycle: ${cycle.join(" -> ")}`);
		assert.equal(cycle.at(0), cycle.at(-1), "a reported cycle must be closed");
	});

	it("keeps both reported cycles structurally impossible", () => {
		for (const [rel, other] of [
			[loader, common],
			[routes, common],
			[routes, loader],
		] as const) {
			assert.equal(pyEdges(rel).includes(mod(other)), false, `${rel} imports ${other}`);
		}
	});

	it("keeps scenario modules on the barrel — no leaf imports outside the family", () => {
		const scenarios = packageModules().filter((rel) => /\/(test_\w+|_bases)\.py$/.test(rel));
		assert.ok(scenarios.length > 5, `expected the scenario modules, got ${scenarios.length}`);
		for (const rel of scenarios) {
			for (const leaf of ["_loader", "_routes", "_fakes"]) {
				assert.equal(
					pyEdges(rel).includes(leaf),
					false,
					`${rel} must import the barrel, not ${leaf}`,
				);
			}
		}
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
			b.before.godObjectCount -
				(b.reducedBy.length + UNCITED_REDUCED.length + (b.reducedByLater?.files.length ?? 0)),
			"after != before - split families",
		);
		assert.equal(b.after.godObjectCount, 20);
	});

	it("preserves the historical deferral ledger", () => {
		const b = baseline();
		const deferred = b.deferred.flatMap((d) => d.files);
		assert.equal(deferred.length, b.after.godObjectCount, "deferred total != after count");
		assert.equal(new Set(deferred).size, deferred.length, "a deferral is listed twice");
		for (const rel of deferred) assert.ok(exists(rel), `deferred path is missing: ${rel}`);
	});

	it("carries reason and requires on every deferral", () => {
		for (const group of baseline().deferred) {
			assert.ok(group.reason.trim().length > 0, "a deferral needs a reason");
			assert.ok(group.requires.trim().length > 0, "a deferral needs what unblocks it");
		}
	});

	it("actually reduced every `reducedBy` file", () => {
		const b = baseline();
		for (const rel of [...b.reducedBy, ...UNCITED_REDUCED, ...(b.reducedByLater?.files ?? [])]) {
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
		const followup = JSON.parse(read("test/fixtures/vba-god-module-baseline-2036.json")) as {
			reducedBy: string[];
			splitFamilies: Record<string, string[]>;
		};
		const deferred = b.deferred.flatMap((d) => d.files);
		const laterReduced = new Set([
			...followup.reducedBy,
			...UNCITED_REDUCED,
			...(b.laterReduced?.files ?? []),
			...(b.reducedByLater?.files ?? []),
		]);
		const laterSiblings = new Set(Object.values(followup.splitFamilies).flat());
		assert.ok(
			live.length <= b.after.godObjectCount,
			`live flagged ${live.length} > recorded ${b.after.godObjectCount}`,
		);
		for (const rel of [...b.reducedBy, ...UNCITED_REDUCED, ...(b.reducedByLater?.files ?? [])]) {
			assert.equal(live.includes(rel), false, `${rel} is still flagged in the live tree`);
		}
		for (const rel of live) {
			assert.ok(deferred.includes(rel) || laterSiblings.has(rel), `${rel} is unrecorded`);
		}
		for (const rel of deferred) {
			if (!live.includes(rel)) {
				assert.ok(laterReduced.has(rel), `${rel} stopped flagging without a follow-up reduction`);
			}
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
		for (const rel of [...UNCITED_REDUCED, ...(b.reducedByLater?.files ?? [])]) {
			assert.equal(b.reducedBy.includes(rel), false, `${rel} is both cited and cross-cited`);
		}
		for (const rel of UNCITED_REDUCED) {
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
