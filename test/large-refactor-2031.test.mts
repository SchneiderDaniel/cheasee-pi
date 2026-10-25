// ─── Large-files refactor contract (issue #2031) ──────────────────
// CodeFlow's `43 Large Files` architecture issue is emitted by the same pinned
// predicate as `God Object`:
//   godFiles = analyzed.filter(f => f.isCode !== false && f.functions.length > 15)
// The shared mirror (`test/fixtures/function-count-mirror.mts`) reproduces the
// analyzer's parser path line-for-line; this oracle adds no detector literal of
// its own, so a re-pin moves one file.
//
// The issue files 43 paths, but the residue at delivery is 20 → 19 flagged
// files. Only `server.py` is both cited and verifiable in-gate: the 19 Rust
// paths need a compiler no workflow provides, and `fp-filter.js` is a delivered
// artifact, not a module seam. This oracle pins the whole partition —
// `reducedBy` / `deferred` / `unfiledFlagged` / `notScored` — so nothing is
// silently dropped, and re-measures the live tree against it.
//
// Run: node --experimental-strip-types --test test/large-refactor-2031.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ANALYZER_REF,
	CODE_EXTS,
	countFunctions,
	functionCountFlagged,
} from "./fixtures/function-count-mirror.mts";
import { isFlagged as longFileFlagged } from "./fixtures/long-file-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const ext = (rel: string): string => rel.split(".").pop()!;
const count = (rel: string): number => countFunctions(read(rel), ext(rel));
const flagged = (rel: string): boolean => functionCountFlagged(read(rel), rel, 15);
const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));

const SHIM = "cmd/cheasee-pi/embedded/docker/codeflow";
const SERVER = `${SHIM}/server.py`;
const ORACLE = "test/large-refactor-2031.test.mts";

type Group = { reason: string; requires?: string; files: string[] };

type Baseline = {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedAnalyzedAt: number;
		filedCount: number;
	};
	before: { ref: string; commit: string; count: number; flagged: string[] };
	after: { ref: string; count: number; note: string };
	reducedBy: string[];
	modules: Record<string, number>;
	deferred: Group[];
	unfiledFlagged: Group[];
	notScored: Group[];
};

const baseline = (): Baseline =>
	JSON.parse(read("test/fixtures/large-files-2031-baseline.json")) as Baseline;

/** The 43 paths the issue files (`architectureIssues[43 Large Files]`). */
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
	`${SHIM}/fp-filter.js`,
	`${SHIM}/run-analysis.mjs`,
	SERVER,
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

/** Every module of the served shim, measured from disk (no hand-kept list). */
const MODULES = readdirSync(resolve(ROOT, SHIM))
	.filter((n) => n.endsWith(".py"))
	.sort()
	.map((n) => `${SHIM}/${n}`);

/** The live flagged set: `git ls-files` filtered by CODE_EXTS and the mirror. */
const liveFlagged = (): string[] =>
	execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
		.trim()
		.split("\n")
		.filter((rel) => CODE_EXTS.includes(`.${ext(rel)}`) && exists(rel) && flagged(rel));

const flat = (groups: Group[]): string[] => groups.flatMap((g) => g.files);

/** Dotted Python sibling imports (`from x import y` / `import x`) in a module. */
const pyImports = (rel: string): string[] => {
	const src = read(rel);
	const out: string[] = [];
	for (const m of src.matchAll(
		/^(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm,
	)) {
		out.push(m[1] ?? m[2]!);
	}
	return out;
};

// ─── The mirror mirrors the pinned detector ───────────────────────

describe("large-files refactor #2031 — the mirror is the pinned detector", () => {
	const mk = (n: number): string =>
		Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join("\n");

	it("pins the analyzer ref the file was derived from", () => {
		assert.match(ANALYZER_REF, /^[0-9a-f]{40}$/);
		assert.equal(baseline().provenance.ref, ANALYZER_REF, "re-pin the fixture with the mirror");
	});

	it("has teeth at the exact boundary (strictly more than 15)", () => {
		assert.equal(countFunctions(mk(15), "ts"), 15);
		assert.equal(functionCountFlagged(mk(15), "x.ts", 15), false, "15 must not be flagged");
		assert.equal(countFunctions(mk(16), "ts"), 16);
		assert.equal(functionCountFlagged(mk(16), "x.ts", 15), true, "16 must be flagged");
	});

	it("is not vacuous", () => {
		assert.equal(countFunctions("", "ts"), 0);
		assert.equal(functionCountFlagged("", "x.ts", 15), false);
	});

	it("gates `.mts` out, so those filed paths can never be reduced", () => {
		assert.equal(CODE_EXTS.includes(".mts"), false);
		assert.equal(functionCountFlagged(mk(16), "sample.mts", 15), false);
		assert.equal(functionCountFlagged(mk(16), "sample.ts", 15), true);
	});

	it("carries no detector literal of its own", () => {
		// Built from parts so this assertion cannot match itself; comment lines are
		// exempt because the pinned predicate is documented, not re-implemented.
		const needle = ["functions.length", ">", "15"].join(" ");
		const code = read(ORACLE)
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		assert.equal(code.includes(needle), false, `${ORACLE} re-defines the predicate`);
	});
});

// ─── The 43-file partition ────────────────────────────────────────

describe("large-files refactor #2031 — the partition is explicit", () => {
	it("records the filed provenance verbatim", () => {
		const p = baseline().provenance;
		assert.equal(p.issue, 2031);
		assert.equal(p.filedCount, 43);
		assert.equal(p.filedAnalyzedAt, 1791804971015);
		assert.match(p.metric, /isCode !== false/);
		assert.match(p.metric, /functions\.length > 15/);
	});

	it("covers the filed list exactly: no path dropped, invented or duplicated", () => {
		const b = baseline();
		const partition = [...b.reducedBy, ...flat(b.deferred), ...flat(b.notScored)];
		assert.equal(new Set(partition).size, partition.length, "a path is listed twice");
		assert.deepEqual([...partition].sort(), [...FILED].sort(), "partition != filed list");
		for (const rel of FILED) assert.ok(exists(rel), `filed path is missing: ${rel}`);
	});

	it("keeps the buckets disjoint and the sizes recorded", () => {
		const b = baseline();
		const reduced = new Set(b.reducedBy);
		const deferred = new Set(flat(b.deferred));
		const notScored = new Set(flat(b.notScored));
		for (const rel of reduced) {
			assert.equal(deferred.has(rel), false, `${rel} is reduced and deferred`);
			assert.equal(notScored.has(rel), false, `${rel} is reduced and notScored`);
		}
		for (const rel of deferred) assert.equal(notScored.has(rel), false, `${rel} is listed twice`);
		assert.deepEqual(b.reducedBy, [SERVER], "this change splits exactly server.py");
		assert.equal(deferred.size, 9, "the filed residue is 8 Rust sources + fp-filter.js");
		assert.equal(notScored.size, 33, "43 - 1 reduced - 9 deferred");
	});

	it("justifies every notScored path with the ceiling it clears", () => {
		const b = baseline();
		const mts = b.notScored.filter((g) => g.files.some((f) => f.endsWith(".mts")));
		assert.equal(mts.length, 1, "the .mts reason is recorded once");
		assert.equal(mts[0]!.files.length, 5, "exactly the 5 filed .mts paths");
		assert.match(mts[0]!.reason, /CODE_EXTS/);
		for (const group of b.notScored) {
			assert.ok(group.reason.trim().length > 0, "every notScored group needs a reason");
			for (const rel of group.files) {
				if (rel.endsWith(".mts")) continue;
				assert.ok(CODE_EXTS.includes(`.${ext(rel)}`), `${rel} is not scored by the analyzer`);
				assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)} — not under the ceiling`);
				assert.equal(flagged(rel), false, `${rel} is flagged, so it is not notScored`);
			}
		}
	});

	it("carries reason and requires on every deferral, all existing", () => {
		for (const group of [...baseline().deferred, ...baseline().unfiledFlagged]) {
			assert.ok(group.reason.trim().length > 0, "a deferral needs a reason");
			assert.ok((group.requires ?? "").trim().length > 0, "a deferral needs what unblocks it");
			for (const rel of group.files) assert.ok(exists(rel), `missing deferral: ${rel}`);
		}
	});

	it("defers only what no gate here can verify", () => {
		const b = baseline();
		for (const rel of flat(b.deferred)) {
			const isRust = rel.endsWith(".rs");
			assert.ok(
				isRust || rel === `${SHIM}/fp-filter.js`,
				`${rel} is neither Rust nor the delivered fp-filter artifact`,
			);
		}
		assert.equal(
			flat(b.deferred).filter((f) => f.endsWith(".rs")).length,
			8,
			"the Rust deferral is the 8 filed sources still over the ceiling",
		);
	});
});

// ─── The metric falls, and the live tree agrees ───────────────────

describe("large-files refactor #2031 — the metric falls", () => {
	it("records the base measurement at an immutable commit", () => {
		const { before } = baseline();
		assert.match(before.commit, /^[0-9a-f]{40}$/);
		assert.equal(before.count, before.flagged.length);
		assert.equal(before.flagged.length, 20);
		assert.equal(new Set(before.flagged).size, 20, "a base file is listed twice");
		assert.ok(before.flagged.includes(SERVER), "server.py was flagged at the base commit");
		for (const rel of before.flagged) assert.ok(exists(rel), `missing: ${rel}`);
	});

	it("after == before - reducedBy", () => {
		const b = baseline();
		assert.equal(b.after.count, b.before.count - b.reducedBy.length);
		assert.equal(b.after.count, 19);
	});

	it("actually reduced every `reducedBy` file", () => {
		for (const rel of baseline().reducedBy) {
			assert.equal(flagged(rel), false, `${rel} is claimed reduced but still flagged`);
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)}`);
		}
	});

	it("matches the live tree: the flagged set is exactly the recorded residue", () => {
		const b = baseline();
		const live = liveFlagged();
		const recorded = [...flat(b.deferred), ...flat(b.unfiledFlagged)].sort();
		assert.deepEqual(live.slice().sort(), recorded, "the live flagged set drifted from the ledger");
		assert.equal(live.length, b.after.count, "after.count != live flagged count");
		assert.equal(live.includes(SERVER), false, "server.py is still flagged in the live tree");
		assert.equal(flagged(`${SHIM}/fp-filter.js`), true, "fp-filter.js is still flagged");
		for (const rel of flat(b.deferred)) {
			assert.equal(flagged(rel), true, `${rel} is deferred but no longer flagged — re-pin it`);
		}
		for (const rel of flat(b.unfiledFlagged)) {
			assert.equal(FILED.includes(rel), false, `${rel} is filed, so it is not unfiled`);
		}
	});
});

// ─── The split adds no flag on either metric ──────────────────────

describe("large-files refactor #2031 — the shim package", () => {
	it("server.py is under the ceiling and every module stays there", () => {
		assert.ok(MODULES.includes(SERVER), "server.py is part of the package");
		for (const rel of MODULES) {
			assert.ok(count(rel) <= 15, `${rel} counts ${count(rel)} (ceiling 15)`);
			assert.equal(flagged(rel), false, `${rel} is flagged`);
			assert.equal(longFileFlagged(read(rel), rel), false, `${rel} is over 500 segments`);
		}
	});

	it("records the measured function count of every split module", () => {
		const recorded = baseline().modules;
		for (const [rel, n] of Object.entries(recorded)) {
			assert.ok(MODULES.includes(rel), `${rel} is not a shim module`);
			assert.equal(count(rel), n, `${rel} drifted from the recorded count`);
		}
		assert.equal(Object.keys(recorded).length, 2, "this change adds server.py + handler_api.py");
	});

	it("keeps one entrypoint: server.py imports the routes, nothing imports server", () => {
		for (const rel of MODULES) {
			if (rel === SERVER) continue;
			assert.equal(pyImports(rel).includes("server"), false, `${rel} imports the entrypoint`);
			assert.doesNotMatch(read(rel), /^\s*from\s+.*\s+import\s+\*$/m, `${rel} star-imports`);
		}
		const routes = `${SHIM}/handler_api.py`;
		assert.ok(MODULES.includes(routes), "the /api/repos routes live in their own module");
		assert.match(read(SERVER), /^from handler_api import /m, "server.py imports the route module");
		assert.deepEqual(
			pyImports(routes)
				.filter((m) => MODULES.includes(`${SHIM}/${m}.py`))
				.sort(),
			["config", "repo_identity"],
			"the route module imports only leaves",
		);
	});

	it("compiles as a package and imports without listening", () => {
		const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
		assert.equal(python.status, 0, "python3 is the only verifier of this package — fail closed");

		// Stage a copy so no __pycache__ or .pyc lands in the worktree.
		const dir = mkdtempSync(join(tmpdir(), "codeflow-2031-"));
		try {
			for (const name of readdirSync(resolve(ROOT, SHIM))) {
				const src = resolve(ROOT, SHIM, name);
				if (statSync(src).isFile()) copyFileSync(src, join(dir, name));
			}
			const compile = spawnSync(
				"python3",
				["-m", "py_compile", ...MODULES.map((rel) => rel.slice(SHIM.length + 1))],
				{ cwd: dir, encoding: "utf-8" },
			);
			assert.equal(compile.status, 0, `py_compile failed: ${compile.stderr}`);

			const script = [
				"import runpy",
				"ns = runpy.run_path('server.py')",
				"h = ns['Handler']",
				"assert hasattr(h, '_api') and hasattr(h, '_list_contents') and hasattr(h, '_file_contents')",
				"assert hasattr(h, 'do_GET') and hasattr(h, 'do_POST')",
				"assert 'ThreadingHTTPServer' in ns, 'the entrypoint still binds its server class'",
				"names = ['_scan', '_walk', '_committed_blobs', '_fingerprint', '_split_fingerprint',",
				"         '_FP_LEN', '_FP_TTL', '_scan_cache', 'REPO_ROOT', 'EXCLUDE_DIRS', '_BRIDGE_JS',",
				"         '_BRIDGE_SCRIPT', '_UI_REWRITES', '_FP_FILTER_ROUTE', '_FP_FILTER_PATH']",
				"missing = [n for n in names if n not in ns]",
				"assert not missing, 'the split dropped pre-split names: %r' % missing",
				"print('ok')",
			].join("\n");
			const run = spawnSync("python3", ["-c", script], {
				cwd: dir,
				encoding: "utf-8",
				timeout: 60_000,
			});
			assert.equal(run.status, 0, `runpy run of server.py failed: ${run.stderr}`);
			assert.match(run.stdout, /ok/, "runpy must reach module scope and return");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ships every module: the Dockerfile COPYs and compiles it", () => {
		const dockerfile = read(`${SHIM}/Dockerfile`);
		const copies = [...dockerfile.matchAll(/^COPY\s+(.+?)\s+\/opt\/codeflow\/$/gm)].map(
			(m) => m[1]!,
		);
		assert.ok(copies.length > 0, "the Dockerfile COPYs the package");
		const copied = copies.flatMap((line) => line.split(/\s+/));
		assert.ok(
			copied.includes("*.py") ||
				MODULES.every((rel) => copied.includes(rel.slice(SHIM.length + 1))),
			"a module is never COPYed into the image",
		);
		assert.match(dockerfile, /^RUN python3 -m py_compile \/opt\/codeflow\/\*\.py$/m);
		assert.match(dockerfile, /^CMD \["python", "\/opt\/codeflow\/server\.py"\]$/m);
	});

	it("stages every module: the Go shim tests copy the whole package", () => {
		const harness = read("cmd/cheasee-pi/codeflow_shim_harness_test.go");
		const block = harness.match(/var codeflowShimModules = \[\]string\{([^}]*)\}/);
		assert.ok(block, "codeflowShimModules is the single staging list");
		const staged = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
		assert.deepEqual(
			staged,
			MODULES.map((rel) => rel.slice(SHIM.length + 1)),
			"staged set != package",
		);
	});
});
