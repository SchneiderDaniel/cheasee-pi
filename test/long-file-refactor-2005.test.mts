// ─── Long-file refactor contract (issue #2005) ────────────────────
// CodeFlow's "Long File" metric is not a semantic detector. The pinned
// analyzer (`index.html` `detectPatterns`, ref below) emits it as
//   longFiles = analyzed.filter(f => f.isCode !== false && f.lines && f.lines > 500)
// where `lines = content.split("\n").length` — a trailing newline therefore
// counts, so a 500-newline file (501 segments) IS flagged. `isCode` gates files
// whose extension is absent from `codeExts`/`scriptContainerExts`: `.mts`,
// `.json` and `.md` are never scored, which is why this oracle — and the record,
// its fixture and the reference doc — can never be a reduction source.
//
// A split only moves the metric when EVERY sibling lands `<= 500` segments. This
// test is the in-gate oracle for that invariant; the recorded measurement
// (produced by the pinned `run-analysis.mjs` over `git archive` snapshots) lives
// in `test/fixtures/long-file-baseline.json` and is replayed by
// `test/codeflow-run-analysis.test.mts`.
//
// Run: node --experimental-strip-types --test test/long-file-refactor-2005.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** The pinned analyzer ref the metric and the mirror were derived from. */
const ANALYZER_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

/** `index.html:1093` `Parser.codeExts` — `.mts`/`.json`/`.md` are absent by design. */
const CODE_EXTS = [
	".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".pyw", ".pyi",
	".java", ".go", ".rb", ".php", ".rs", ".c", ".cpp", ".cc", ".cxx", ".h",
	".hpp", ".hh", ".hxx", ".cs", ".swift", ".kt", ".kts", ".scala", ".sc",
	".clj", ".cljs", ".cljc", ".ex", ".exs", ".erl", ".hrl", ".hs", ".lhs",
	".lua", ".r", ".R", ".jl", ".dart", ".elm", ".fs", ".fsi", ".fsx", ".ml",
	".mli", ".pl", ".pm", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1",
	".psd1", ".groovy", ".gvy", ".gradle", ".vba", ".bas", ".cls", ".xlsm",
	".xlam", ".xlsb", ".xla", ".xlw", ".pas", ".pp", ".dpr", ".dpk", ".lpr",
	".inc",
];

/** Files this change split, and the siblings each split produced. */
const TOUCHED: Record<string, string[]> = {
	// Production: helper halves lifted verbatim, original keeps its exported names
	// as explicit named re-exports (no `export *`).
	".pi/extensions/supervisor/pipeline/handler/agent-loop.ts": [
		".pi/extensions/supervisor/pipeline/handler/agent-loop-helpers.ts",
	],
	".pi/extensions/supervisor/checks/osv-scanner.ts": [
		".pi/extensions/supervisor/checks/osv-severity.ts",
	],
	".pi/extensions/supervisor/pipeline/merge.ts": [
		".pi/extensions/supervisor/pipeline/merge-conflicts.ts",
		".pi/extensions/supervisor/pipeline/pr-gate.ts",
	],
	".pi/extensions/supervisor/pipeline/worktree.ts": [
		".pi/extensions/supervisor/pipeline/worktree-deps.ts",
	],
	".pi/extensions/supervisor/agent/runner/index.ts": [
		".pi/extensions/supervisor/agent/runner/spawned-run.ts",
	],
	".pi/extensions/ripgrep-search/index.ts": [
		".pi/extensions/ripgrep-search/render.ts",
		".pi/extensions/ripgrep-search/summary.ts",
	],
	// Test suites: whole `describe` blocks move, shared fixtures land in
	// non-`.test.ts` modules so `node --test` does not load them as suites.
	".pi/extensions/agent-harness/test/index.test.ts": [
		".pi/extensions/agent-harness/test/harness-fixtures.ts",
		".pi/extensions/agent-harness/test/index-cascade.test.ts",
		".pi/extensions/agent-harness/test/index-entry.test.ts",
		".pi/extensions/agent-harness/test/index-config.test.ts",
		".pi/extensions/agent-harness/test/index-bypass.test.ts",
		".pi/extensions/agent-harness/test/index-dispatch.test.ts",
	],
	".pi/extensions/lib/ensureVenv.test.ts": [
		".pi/extensions/lib/test/ensureVenv-fixtures.ts",
		".pi/extensions/lib/ensureVenv-retry.test.ts",
		".pi/extensions/lib/ensureVenv-errors.test.ts",
		".pi/extensions/lib/ensureVenv-concurrency.test.ts",
	],
	".pi/extensions/scrapling/test/index-handler.test.ts": [
		".pi/extensions/scrapling/test/index-handler-factory.test.ts",
		".pi/extensions/scrapling/test/index-handler-contracts.test.ts",
	],
	".pi/extensions/scrapling/test/python-adapter.test.ts": [
		".pi/extensions/scrapling/test/python-adapter-fixtures.ts",
		".pi/extensions/scrapling/test/python-adapter-journey.test.ts",
	],
	".pi/extensions/web-search/test/index.test.ts": [
		".pi/extensions/web-search/test/web-search-fixtures.ts",
		".pi/extensions/web-search/test/index-cache-concurrency.test.ts",
	],
	".pi/extensions/tsc-checkpoint/test/index.test.ts": [
		".pi/extensions/tsc-checkpoint/test/fixtures.ts",
		".pi/extensions/tsc-checkpoint/test/lifecycle.test.ts",
	],
	".pi/extensions/web-search/test/executor.test.ts": [
		".pi/extensions/web-search/test/executor-parsing.test.ts",
	],
	".pi/extensions/rtk/test/version-gate.test.ts": [
		".pi/extensions/rtk/test/version-gate-lifecycle.test.ts",
	],
	// Go: whole `func Test…` declarations (and their harness helpers) move
	// verbatim between files of `package main`.
	"cmd/cheasee-pi/codeflow_run_test.go": [
		"cmd/cheasee-pi/codeflow_run_harness_test.go",
		"cmd/cheasee-pi/codeflow_run_guards_test.go",
	],
	"cmd/cheasee-pi/codeflow_report_test.go": ["cmd/cheasee-pi/codeflow_report_bridge_test.go"],
	"cmd/cheasee-pi/codeflow_report_guard_test.go": [
		"cmd/cheasee-pi/codeflow_report_guard_concurrency_test.go",
	],
	"cmd/cheasee-pi/up_flow_test.go": ["cmd/cheasee-pi/up_flow_container_test.go"],
	// Python: harness + one module per TestCase class, thin `python3` entry.
	"test/dependency-existence-check.test.py": [
		"test/dependency_existence_check_tests/__init__.py",
		"test/dependency_existence_check_tests/_common.py",
		"test/dependency_existence_check_tests/test_pipeline_age_guard.py",
		"test/dependency_existence_check_tests/test_discovery_gitignore.py",
		"test/dependency_existence_check_tests/test_adapter_extraction.py",
		"test/dependency_existence_check_tests/test_registry_transport.py",
		"test/dependency_existence_check_tests/test_ignore_mechanism.py",
		"test/dependency_existence_check_tests/test_end_to_end.py",
	],
};

const ALL_FILES = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

/** The 15 Rust sources under `embedded/docker/ui` and the embedded server.py. */
const DEFERRED_RUST = [
	"cmd/cheasee-pi/embedded/docker/ui/src/controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/main.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/pi_process.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/protocol.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/retry.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/rpc/client.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/session.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/stream.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/extension_ui.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/reconnect.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/rpc_protocol.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/session_controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/stream_assembly.rs",
];
const DEFERRED_SERVER = "cmd/cheasee-pi/embedded/docker/codeflow/server.py";

// ─── CodeFlow long-file mirror ────────────────────────────────────

/** `lines = content.split("\n").length` — the analyzer's own segment count. */
function lineCount(src: string): number {
	return src.split("\n").length;
}

/** The analyzer's `longFiles` predicate, including the `isCode` gate. */
function isFlagged(src: string, rel: string): boolean {
	const ext = `.${rel.split(".").pop()}`;
	if (!CODE_EXTS.includes(ext)) return false;
	return lineCount(src) > 500;
}

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");

interface Baseline {
	provenance: { metric: string };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
}

const BASELINE = JSON.parse(
	readFileSync(resolve(ROOT, "test/fixtures/long-file-baseline.json"), "utf-8"),
) as Baseline;

// ─── The mirror mirrors the pinned detector ───────────────────────

describe("long-file refactor #2005 — the mirror is the pinned detector", () => {
	it("pins the 40-hex analyzer ref", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
	});

	it("has teeth at the exact boundary (strictly more than 500 segments)", () => {
		const mk = (segments: number): string => "x\n".repeat(segments - 1) + "x";
		assert.equal(lineCount(mk(500)), 500);
		assert.equal(isFlagged(mk(500), "x.ts"), false, "500 segments must not be flagged");
		assert.equal(lineCount(mk(501)), 501);
		assert.equal(isFlagged(mk(501), "x.ts"), true, "501 segments must be flagged");
	});

	it("counts a trailing newline — 500 newlines is 501 segments", () => {
		const trailing = "export const x = 1;\n".repeat(500);
		assert.equal(lineCount(trailing), 501);
		assert.equal(isFlagged(trailing, "x.ts"), true, "500 wc-l lines plus the terminator is flagged");
	});

	it("is not vacuous — empty content is one segment, not zero", () => {
		assert.equal(lineCount(""), 1);
		assert.equal(isFlagged("", "x.ts"), false);
	});

	it("gates `.mts`/`.json`/`.md` out, but scores the same text as `.ts`", () => {
		const long = "x\n".repeat(600);
		for (const ext of [".mts", ".json", ".md"]) {
			assert.equal(CODE_EXTS.includes(ext), false, `${ext} is not a scored extension`);
			assert.equal(isFlagged(long, `sample${ext}`), false, `${ext} is never scored`);
		}
		assert.equal(isFlagged(long, "sample.ts"), true, "the same text as .ts is scored");
	});
});

// ─── Manifest ─────────────────────────────────────────────────────

describe("long-file refactor #2005 — manifest", () => {
	it("is not vacuous: many families, each with at least one sibling", () => {
		const families = Object.keys(TOUCHED);
		assert.ok(families.length >= 10, `expected >=10 families, got ${families.length}`);
		for (const [rel, siblings] of Object.entries(TOUCHED)) {
			assert.ok(siblings.length >= 1, `${rel} lists no sibling module`);
		}
		assert.ok(
			ALL_FILES.length >= 2 * families.length,
			"the manifest must name more files than families",
		);
	});

	it("covers production, TS test, Go test and Python splits", () => {
		const families = Object.keys(TOUCHED);
		assert.ok(families.includes(".pi/extensions/supervisor/pipeline/handler/agent-loop.ts"));
		assert.ok(families.includes(".pi/extensions/agent-harness/test/index.test.ts"));
		assert.ok(families.includes("cmd/cheasee-pi/codeflow_run_test.go"));
		assert.ok(families.includes("test/dependency-existence-check.test.py"));
	});

	it("every listed file exists and is listed exactly once", () => {
		for (const rel of ALL_FILES) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing manifest file: ${rel}`);
		}
		assert.equal(new Set(ALL_FILES).size, ALL_FILES.length, "a file is listed twice");
	});

	it("cites no `.mts` (or lower-case `.mts` sibling) as a split member", () => {
		for (const rel of ALL_FILES) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is never counted by the analyzer`);
		}
	});
});

// ─── The invariant that makes the metric fall ─────────────────────

describe("long-file refactor #2005 — every file is under the metric", () => {
	for (const rel of ALL_FILES) {
		it(`${rel} counts <= 500 segments and is not flagged`, () => {
			const segments = lineCount(read(rel));
			assert.ok(segments <= 500, `${rel} counts ${segments} segments (ceiling 500)`);
			assert.equal(isFlagged(read(rel), rel), false, `${rel} is still flagged`);
		});
	}
});

// ─── Register guards ──────────────────────────────────────────────

describe("long-file refactor #2005 — register guards", () => {
	it("reducedBy is non-empty, `.mts`-free and exists", () => {
		assert.ok(BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of BASELINE.reducedBy) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is never counted by the analyzer`);
			assert.ok(existsSync(resolve(ROOT, rel)), `missing reduction source: ${rel}`);
		}
	});

	it("cites every split family in reducedBy", () => {
		for (const rel of Object.keys(TOUCHED)) {
			assert.ok(
				BASELINE.reducedBy.includes(rel),
				`baseline.reducedBy is missing the split family ${rel}`,
			);
		}
	});

	it("no path is both reduced and deferred, and every deferral states a reason", () => {
		for (const entry of BASELINE.deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
			for (const rel of entry.files ?? []) {
				assert.ok(existsSync(resolve(ROOT, rel)), `missing deferred path: ${rel}`);
				assert.ok(
					!BASELINE.reducedBy.includes(rel),
					`${rel} is both deferred and cited as reduced`,
				);
			}
		}
	});

	it("records the Rust set and the embedded server.py as deferred", () => {
		const flat = BASELINE.deferred.flatMap((d) => d.files ?? []);
		for (const rel of [...DEFERRED_RUST, DEFERRED_SERVER]) {
			assert.ok(flat.includes(rel), `${rel} must be split or deferred, never omitted`);
			assert.ok(existsSync(resolve(ROOT, rel)), `missing deferred path: ${rel}`);
		}
	});

	it("keeps the metric wording in the fixture in sync with this mirror", () => {
		assert.match(BASELINE.provenance.metric, /isCode !== false/);
		assert.match(BASELINE.provenance.metric, /lines > 500/);
	});
});
