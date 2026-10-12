/**
 * Tests for cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs — the
 * headless producer the shim drives.
 *
 * A fixture UI dir (index.html carrying a self-contained CODEFLOW_ANALYZER
 * block + card/lib stand-ins) and a fixture sourceDir exercise the runner
 * without the real CodeFlow checkout. The runner is spawned as a real child
 * process so argv handling and exit codes are covered.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-run-analysis.test.mts
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { measureWorktree } from "./fixtures/long-file-mirror.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");

const ANALYZER_BLOCK = `
// ===== CODEFLOW_ANALYZER_START =====
const Parser = { functionKey: function (fn) { return fn.name; } };
function buildAnalysisData(opts) { return { files: [], stats: {}, marker: "FIXTURE" }; }
// ===== CODEFLOW_ANALYZER_END =====
// ===== CODEFLOW_METRICS_START =====
function calcHealth(data) { return { score: 100, grade: "A" }; }
// ===== CODEFLOW_METRICS_END =====
`;

// generateReport mirrors the UI export seam: it builds a Blob and hands it to
// URL.createObjectURL, which the runner stubs to capture the bytes.
function generateReportBody(emitJson = true): string {
	return `
function generateReport(format) {
  if (format === "json"${emitJson ? "" : " && false"}) {
    var blob = new Blob([JSON.stringify({ architectureIssues: data.architectureIssues || [], duplicates: [{ files: ["a", "b"] }], layerViolations: data.layerViolations || [{ from: "UI", to: "DB" }], suggestions: [{ text: "split" }], marker: data.marker, securityIssues: data.securityIssues || null })], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "codeflow-report.json";
    a.click();
    URL.revokeObjectURL(url);
  } else if (format === "md") {
    var md = "# CodeFlow Analysis Report\\n\\nmarker=" + data.marker + "\\n";
    var blob2 = new Blob([md], { type: "text/markdown" });
    var url2 = URL.createObjectURL(blob2);
    var a2 = document.createElement("a");
    a2.href = url2;
    a2.download = "codeflow-report.md";
    a2.click();
    URL.revokeObjectURL(url2);
  }
}
`;
}

interface Fixture {
	uiDir: string;
	sourceDir: string;
	outDir: string;
}

/** The analysis.js stand-in that returns a fixed `data` object. */
function analysisJs(data: unknown): string {
	return `"use strict";
module.exports = {
  async analyze() {
    return { schemaVersion: 1, data: ${JSON.stringify(data)}, snapshot: {} };
  },
};
`;
}

// Formula fixture only. The issue's live run (`local/workspace-f4048b9b`):
// 5006 connections over 1026 files is the coupling input, 24 dead of 4890
// functions the dead-code one. The real pinned-analyzer calibration
// (connection unit, repository before/after) is captured in the issue's
// analysis artifacts.
const CANON_STATS = { files: 1026, functions: 4890, connections: 5006, dead: 24, loc: 12345 };

function makeFixture(
	opts: {
		emitJson?: boolean;
		analyzerBlock?: string;
		analysisJs?: string | null;
		stats?: unknown;
	} = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "codeflow-runner-"));
	const uiDir = join(root, "ui");
	const sourceDir = join(root, "src");
	const outDir = join(root, "out");
	mkdirSync(join(uiDir, "card", "lib"), { recursive: true });
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(sourceDir, "a.ts"), "export const a = 1;\n");
	const block = opts.analyzerBlock ?? ANALYZER_BLOCK;
	writeFileSync(
		join(uiDir, "index.html"),
		`<html><body><script type="text/babel">${block}${generateReportBody(opts.emitJson !== false)}</script></body></html>`,
	);
	if (opts.analysisJs !== null) {
		writeFileSync(
			join(uiDir, "card", "lib", "analysis.js"),
			opts.analysisJs ??
				`"use strict";
const stats = ${"stats" in opts ? JSON.stringify(opts.stats) : JSON.stringify(CANON_STATS)};
module.exports = {
  async analyze(options) {
    return { schemaVersion: 1, data: { marker: "FIXTURE", stats }, snapshot: {} };
  },
};
`,
		);
	}
	return { uiDir, sourceDir, outDir };
}

function runRunner(fx: Fixture): { code: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [RUNNER, fx.sourceDir, fx.uiDir, fx.outDir], {
		encoding: "utf-8",
	});
	return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function envelope(stdout: string): {
	markdown: string;
	json: string | null;
	analyzedAt: number;
	stats: Record<string, number> | null;
	terms: { coupling: number; deadCode: number } | null;
} {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
}

const runWithStats = (stats: unknown, emitJson = true) => {
	const fx = makeFixture({ stats, emitJson });
	const { code, stdout, stderr } = runRunner(fx);
	return { code, stderr, env: envelope(stdout), fx };
};

describe("run-analysis.mjs headless producer", () => {
	it("writes both artifacts, exits 0 and prints the result envelope", () => {
		const fx = makeFixture();
		const { code, stdout, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.ok(existsSync(join(fx.outDir, "report.md")), "report.md must exist");
		assert.ok(existsSync(join(fx.outDir, "report.json")), "report.json must exist");
		const env = envelope(stdout);
		assert.strictEqual(env.markdown, "report.md");
		assert.strictEqual(env.json, "report.json");
		assert.ok(
			typeof env.analyzedAt === "number" && env.analyzedAt > 0,
			"analyzedAt must be epoch ms",
		);
	});

	it("captures the bytes handed to URL.createObjectURL verbatim", () => {
		const fx = makeFixture();
		const { code } = runRunner(fx);
		assert.strictEqual(code, 0);
		assert.strictEqual(
			readFileSync(join(fx.outDir, "report.md"), "utf-8"),
			"# CodeFlow Analysis Report\n\nmarker=FIXTURE\n",
		);
		const produced = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.strictEqual(produced.marker, "FIXTURE");
		// JSON-only categories the markdown export omits must survive verbatim.
		assert.deepStrictEqual(produced.duplicates, [{ files: ["a", "b"] }]);
		assert.deepStrictEqual(produced.layerViolations, [{ from: "UI", to: "DB" }]);
		assert.deepStrictEqual(produced.suggestions, [{ text: "split" }]);
	});

	it("succeeds without a JSON export (envelope json:null, no report.json)", () => {
		const fx = makeFixture({ emitJson: false });
		const { code, stdout } = runRunner(fx);

		assert.strictEqual(code, 0);
		assert.ok(existsSync(join(fx.outDir, "report.md")));
		assert.ok(!existsSync(join(fx.outDir, "report.json")), "no report.json must be written");
		assert.strictEqual(envelope(stdout).json, null);
	});

	it("fails closed when the CODEFLOW_ANALYZER block is missing, leaving no artifacts", () => {
		const fx = makeFixture({ analyzerBlock: "const unrelated = true;\n" });
		const { code, stderr } = runRunner(fx);

		assert.notStrictEqual(code, 0);
		assert.match(stderr, /CODEFLOW_ANALYZER/);
		assert.ok(stderr.length <= 4096, "stderr must be bounded");
		assert.ok(!existsSync(join(fx.outDir, "report.md")));
		assert.ok(!existsSync(join(fx.outDir, "report.json")));
	});

	it("fails closed when card/lib/analysis.js cannot be imported, with bounded stderr", () => {
		const fx = makeFixture({ analysisJs: null });
		const { code, stderr } = runRunner(fx);

		assert.notStrictEqual(code, 0);
		assert.ok(stderr.length <= 4096, "stderr must be bounded");
		assert.ok(!existsSync(join(fx.outDir, "report.md")));
		assert.ok(!existsSync(join(fx.outDir, "report.json")));
	});

	it("fails closed when the UI export emits no Blob for markdown", () => {
		const block = `${ANALYZER_BLOCK}function generateReport() { /* emits nothing */ }\n`;
		const fx = makeFixture({ analyzerBlock: block });
		const { code, stderr } = runRunner(fx);

		assert.notStrictEqual(code, 0);
		assert.match(stderr, /no Blob|empty markdown/i);
		assert.ok(!existsSync(join(fx.outDir, "report.md")));
	});

	it("imports only node: builtins (zero npm dependencies)", () => {
		const src = readFileSync(RUNNER, "utf-8");
		const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		assert.ok(specifiers.length > 0, "runner must have imports");
		for (const spec of specifiers) {
			assert.ok(spec.startsWith("node:"), `non-builtin import ${spec}`);
		}
		assert.doesNotMatch(src, /require\(\s*["'][^"']+["']\s*\)/, "no third-party require");
	});

	it("suppresses analyzer false positives before the exports are built", () => {
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "FP",
				stats: { files: 3, functions: 1, loc: 3 },
				securityIssues: [
					{
						severity: "high",
						title: "Hardcoded Secret",
						description: "Possible hardcoded API key.",
						path: "types.ts",
						line: 1,
						code: 'export type UsageColorToken = "success" | "warning" | "error";',
					},
					{
						severity: "high",
						title: "Shell Command Execution",
						description: "Shell() call detected.",
						path: "main.rs",
						line: 2,
						code: "",
					},
					{
						severity: "high",
						title: "Hardcoded Secret",
						description: "Possible hardcoded API key.",
						path: "keep.ts",
						line: 3,
						code: 'const KEY = "sk-live-abc";',
					},
				],
				layerViolations: [
					{ from: "keep.ts", to: "main.rs", fromLayer: "ui", toLayer: "ui" },
					{ from: "keep.ts", to: "other.ts", fromLayer: "ui" },
				],
				files: [
					{ path: "keep.ts", layer: "ui" },
					{ path: "other.ts", layer: "ui" },
					{ path: "main.rs", layer: "ui" },
				],
				connections: [],
			}),
		});
		writeFileSync(join(fx.sourceDir, "keep.ts"), 'export const KEY = "sk-live-abc";\n');
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(
			json.securityIssues.map((s: { path: string }) => s.path),
			["keep.ts"],
			"only the true positive may survive",
		);
		assert.deepStrictEqual(json.layerViolations, [], "the layer category is noise here");
		assert.match(
			stderr,
			/fp-filter: suppressed 2 security issue\(s\), 2 layer violation\(s\)/,
			"suppression must be observable, never silent",
		);
	});

	it("reads the cited file from the snapshot: phantom symbol dropped, present symbol kept", () => {
		const issue = (path: string) => ({
			severity: "high",
			title: "Shell Command Execution",
			description: "Shell() call detected.",
			path,
			line: 1,
			code: "let a = 1;",
		});
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "READ",
				securityIssues: [issue("phantom.ts"), issue("real.ts"), issue("absent.ts")],
			}),
		});
		writeFileSync(join(fx.sourceDir, "phantom.ts"), "export const a = 1;\n");
		writeFileSync(join(fx.sourceDir, "real.ts"), "export function Shell() {}\n");
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const kept = JSON.parse(
			readFileSync(join(fx.outDir, "report.json"), "utf-8"),
		).securityIssues.map((s: { path: string }) => s.path);
		assert.deepStrictEqual(kept, ["real.ts", "absent.ts"]);
	});

	it("refuses to read a cited file whose symlink escapes the snapshot", () => {
		// A tracked symlink can point outside the archived tree; a lexical
		// containment check cannot see that, so the reader must reject it and the
		// finding whose disproof would have needed those contents must stand.
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "SYMLINK",
				securityIssues: [
					{
						severity: "high",
						title: "Shell Command Execution",
						description: "Shell() call detected.",
						path: "escape.ts",
						line: 1,
						code: "let a = 1;",
					},
				],
			}),
		});
		const outside = join(dirname(fx.sourceDir), "outside.ts");
		writeFileSync(outside, "export const a = 1;\n"); // lacks Shell(), so reading it would drop the finding
		symlinkSync(outside, join(fx.sourceDir, "escape.ts"));
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const kept = JSON.parse(
			readFileSync(join(fx.outDir, "report.json"), "utf-8"),
		).securityIssues.map((s: { path: string }) => s.path);
		assert.deepStrictEqual(
			kept,
			["escape.ts"],
			"a symlink target outside the snapshot must not be read",
		);
	});

	it("leaves data without securityIssues/layerViolations alone and stays quiet", () => {
		const fx = makeFixture();
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.strictEqual(stderr, "", "nothing was suppressed, so nothing is reported");
		assert.strictEqual(
			readFileSync(join(fx.outDir, "report.md"), "utf-8"),
			"# CodeFlow Analysis Report\n\nmarker=FIXTURE\n",
		);
		assert.strictEqual(
			JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8")).securityIssues,
			null,
		);
	});

	it("fails closed when the sanitizer throws, exporting no artifact", () => {
		const fx = makeFixture({
			analysisJs: `"use strict";
module.exports = {
  async analyze() {
    return { data: { marker: "THROW", securityIssues: [{ get severity() { throw new Error("fp-filter exploded"); } }] } };
  },
};
`,
		});
		const { code, stderr } = runRunner(fx);

		assert.notStrictEqual(code, 0);
		assert.match(stderr, /fp-filter exploded/);
		assert.ok(stderr.length <= 4096, "stderr must be bounded");
		assert.ok(!existsSync(join(fx.outDir, "report.md")), "no unsanitized markdown may be written");
		assert.ok(!existsSync(join(fx.outDir, "report.json")), "no unsanitized JSON may be written");
	});
});

describe("run-analysis.mjs score-term measurement", () => {
	it("prints the analyzer stats verbatim and derives both live score terms", () => {
		const { code, stderr, env } = runWithStats(CANON_STATS);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.deepStrictEqual(env.stats, CANON_STATS, "stats must pass through un-remapped");
		assert.strictEqual(env.stats?.files, 1026);
		assert.strictEqual(env.stats?.connections, 5006);
		assert.strictEqual(env.stats?.dead, 24);
		assert.deepStrictEqual(env.terms, { coupling: 3.758, deadCode: 0.491 });
	});

	it("coupling term is 0 at ratio <= 3 and caps at 15", () => {
		const zero = runWithStats({ ...CANON_STATS, files: 1000, connections: 3000 });
		assert.strictEqual(zero.code, 0, `stderr: ${zero.stderr}`);
		assert.strictEqual(zero.env.terms?.coupling, 0);

		const below = runWithStats({ ...CANON_STATS, files: 1000, connections: 2500 });
		assert.strictEqual(below.env.terms?.coupling, 0);

		const capped = runWithStats({ ...CANON_STATS, files: 1000, connections: 10500 });
		assert.strictEqual(capped.env.terms?.coupling, 15);

		const wayOver = runWithStats({ ...CANON_STATS, files: 1000, connections: 99000 });
		assert.strictEqual(wayOver.env.terms?.coupling, 15);
	});

	it("dead-code term is 0 with no dead functions and caps at 20 at 20% dead", () => {
		const none = runWithStats({ ...CANON_STATS, dead: 0 });
		assert.strictEqual(none.code, 0, `stderr: ${none.stderr}`);
		assert.strictEqual(none.env.terms?.deadCode, 0);

		const capped = runWithStats({ ...CANON_STATS, files: 1000, functions: 1000, dead: 200 });
		assert.strictEqual(capped.env.terms?.deadCode, 20);

		const wayOver = runWithStats({ ...CANON_STATS, files: 1000, functions: 1000, dead: 900 });
		assert.strictEqual(wayOver.env.terms?.deadCode, 20);
	});

	it("yields terms:null for unusable stats without failing the run", () => {
		const cases: Array<[string, unknown]> = [
			["missing files", { ...CANON_STATS, files: undefined }],
			["missing connections", { ...CANON_STATS, connections: undefined }],
			["zero files", { ...CANON_STATS, files: 0 }],
			["zero functions", { ...CANON_STATS, functions: 0 }],
			["negative connections", { ...CANON_STATS, connections: -1 }],
			["non-finite files", { ...CANON_STATS, files: Number.POSITIVE_INFINITY }],
			["non-numeric dead", { ...CANON_STATS, dead: "24" }],
			["stats absent", undefined],
		];
		for (const [label, stats] of cases) {
			const { code, stderr, env, fx } = runWithStats(stats);
			assert.strictEqual(code, 0, `${label}: stderr: ${stderr}`);
			assert.strictEqual(env.terms, null, `${label}: terms must be null`);
			assert.ok(existsSync(join(fx.outDir, "report.md")), `${label}: report.md must exist`);
			assert.ok(existsSync(join(fx.outDir, "report.json")), `${label}: report.json must exist`);
			assert.ok(typeof env.analyzedAt === "number", `${label}: analyzedAt must survive`);
		}
	});

	it("regression: existing envelope keys and the all-json path are unchanged", () => {
		const { code, env } = runWithStats({ ...CANON_STATS, connections: 1000, files: 1000 });
		assert.strictEqual(code, 0);
		assert.strictEqual(env.markdown, "report.md");
		assert.strictEqual(env.json, "report.json");
		assert.strictEqual(env.terms?.coupling, 0);

		const noJson = runWithStats(CANON_STATS, false);
		assert.strictEqual(noJson.env.json, null);
		assert.notStrictEqual(noJson.env.terms, null, "measurement is independent of the json export");
	});
});

// Issue #2002: the `N Highly Coupled` count is the acceptance metric, so the
// oracle plumbing and the recorded before/after are pinned here. The record was
// produced by the pinned analyzer over `git archive <commit>` snapshots of the
// immutable base and the delivered branch (see the fixture's `provenance` for
// the exact method and commit IDs); this block replays the envelope/report
// seams the number depends on and asserts the recorded measurement. The live
// analyzer run needs the pinned CodeFlow checkout and minutes, so it stays out
// of this in-gate suite — the fixture holds the envelope it printed.
const COUPLING_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "coupling-baseline.json"), "utf-8"),
) as {
	provenance: { filedCoupled: number };
	before: {
		commit: string;
		files: number;
		functions: number;
		connections: number;
		coupled: number;
	};
	after: { commit: string; files: number; functions: number; connections: number; coupled: number };
	reducedBy: string[];
	callSiteOnly: string[];
};

describe("coupling metric oracle (issue #2002)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(
			COUPLING_BASELINE.provenance.filedCoupled,
			134,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		for (const [side, ref] of [
			["before", COUPLING_BASELINE.before],
			["after", COUPLING_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			COUPLING_BASELINE.after.commit,
			COUPLING_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			COUPLING_BASELINE.after.connections < COUPLING_BASELINE.before.connections,
			"the coupling term must fall, not just the flagged-file count",
		);
		assert.ok(
			COUPLING_BASELINE.after.coupled < COUPLING_BASELINE.before.coupled,
			"fewer files must exceed the 8-reference threshold",
		);
	});

	it("cites no test-only .mts file as a reduction source", () => {
		for (const rel of COUPLING_BASELINE.reducedBy) {
			assert.ok(!rel.endsWith(".mts"), `${rel} is test-only: the pinned analyzer never counts it`);
		}
		for (const rel of COUPLING_BASELINE.callSiteOnly) {
			assert.ok(rel.endsWith(".mts"), `${rel} is not test-only, so it belongs in reducedBy`);
		}
	});

	it("passes stats.connections un-remapped and keeps the coupled title verbatim", () => {
		const stats = {
			files: COUPLING_BASELINE.after.files,
			functions: COUPLING_BASELINE.after.functions,
			connections: COUPLING_BASELINE.after.connections,
			dead: 45,
			loc: 1,
		};
		const title = `${COUPLING_BASELINE.after.coupled} Highly Coupled`;
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "COUPLING",
				stats,
				architectureIssues: [{ type: "warning", title }],
			}),
		});
		const { code, stdout, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const env = envelope(stdout);
		assert.strictEqual(env.stats?.connections, stats.connections, "connections pass through");
		assert.deepStrictEqual(env.stats, stats);
		assert.ok(typeof env.analyzedAt === "number" && env.analyzedAt > 0, "analyzedAt survives");
		assert.ok((env.terms?.coupling ?? 0) > 0, "the derived term is computed from the same stats");

		const produced = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.strictEqual(produced.architectureIssues[0].title, title);
	});
});

// ─── High-complexity-files oracle (issue #2003) ───────────────────
// The pinned analyzer run needs the CodeFlow checkout and a `git archive` of
// two commits, so the measurement itself stays out of this in-gate suite (the
// mirror that enforces the `<= 30` per-sibling invariant lives in
// `test/complexity-refactor-2003.test.mts`). This block replays the recorded
// before/after on the immutable commits and guards the record's shape.
const COMPLEXITY_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "complexity-baseline.json"), "utf-8"),
) as {
	provenance: { issue: number; ref: string; metric: string; filedCount: number };
	before: { commit: string; files: number; complexityCount: number };
	after: { commit: string; files: number; complexityCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

describe("complexity metric oracle (issue #2003)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(COMPLEXITY_BASELINE.provenance.issue, 2003);
		assert.strictEqual(
			COMPLEXITY_BASELINE.provenance.filedCount,
			202,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.match(COMPLEXITY_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			COMPLEXITY_BASELINE.provenance.metric,
			/critical/,
			"the metric names the `critical` predicate",
		);
		for (const [side, ref] of [
			["before", COMPLEXITY_BASELINE.before],
			["after", COMPLEXITY_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			COMPLEXITY_BASELINE.after.commit,
			COMPLEXITY_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.strictEqual(
			COMPLEXITY_BASELINE.before.complexityCount,
			216,
			"the re-measured base on origin/main",
		);
		assert.ok(
			COMPLEXITY_BASELINE.after.complexityCount < COMPLEXITY_BASELINE.before.complexityCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			COMPLEXITY_BASELINE.after.files > COMPLEXITY_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(COMPLEXITY_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of COMPLEXITY_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust and embedded .sh/.js sets with reasons, and touches none of them", () => {
		const deferred = COMPLEXITY_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and .sh/.js deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const shellJs = withFiles.find((d) => d.files!.every((f) => /\.(sh|js|mjs)$/.test(f)));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(shellJs, "the embedded .sh/.js set is recorded as deferred");
		assert.ok(rust.files!.length >= 8 && shellJs.files!.length >= 5);
		for (const rel of [...rust.files!, ...shellJs.files!]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!COMPLEXITY_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});
});

// ─── God-object oracle (issue #2004) ──────────────────────────────
// Same shape as the #2003 block above: the pinned analyzer run needs the
// CodeFlow checkout and a `git archive` of two commits, so the measurement
// stays out of this in-gate suite (the mirror that enforces the `<= 15`
// per-sibling invariant lives in `test/god-object-refactor-2004.test.mts`).
// This block replays the recorded before/after and guards the record's shape.
const GOD_OBJECT_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "god-object-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; godObjectCount: number };
	after: { commit: string; files: number; godObjectCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

describe("god object metric oracle (issue #2004)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(GOD_OBJECT_BASELINE.provenance.issue, 2004);
		assert.strictEqual(
			GOD_OBJECT_BASELINE.provenance.filedCount,
			63,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(GOD_OBJECT_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(GOD_OBJECT_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			GOD_OBJECT_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(
			GOD_OBJECT_BASELINE.provenance.metric,
			/functions\.length > 15/,
			"the metric names the exact predicate",
		);
		for (const [side, ref] of [
			["before", GOD_OBJECT_BASELINE.before],
			["after", GOD_OBJECT_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			GOD_OBJECT_BASELINE.after.commit,
			GOD_OBJECT_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			GOD_OBJECT_BASELINE.after.godObjectCount < GOD_OBJECT_BASELINE.before.godObjectCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			GOD_OBJECT_BASELINE.after.files > GOD_OBJECT_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(GOD_OBJECT_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of GOD_OBJECT_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust, embedded asset and offline-suite sets with reasons", () => {
		const deferred = GOD_OBJECT_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and .sh/.js deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const shellJs = withFiles.find((d) => d.files!.every((f) => /\.(sh|js|mjs)$/.test(f)));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(shellJs, "the embedded .sh/.js set is recorded as deferred");
		assert.ok(rust.files!.length >= 8 && shellJs.files!.length >= 5);
		for (const rel of [...rust.files!, ...shellJs.files!]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!GOD_OBJECT_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		// The offline safety-net suite is the one flagged file this change does not
		// split; it must be named in deferred[] with a reason rather than dropped.
		const suite = "test/dependency-existence-check.test.py";
		const entry = GOD_OBJECT_BASELINE.deferred.find((d) => (d.files ?? []).includes(suite));
		assert.ok(entry, `${suite} must be split or deferred, never silently omitted`);
		assert.ok(entry!.reason.length > 0, `${suite} deferral must state a reason`);
		assert.ok(
			!GOD_OBJECT_BASELINE.reducedBy.includes(suite),
			`${suite} is both deferred and cited as reduced`,
		);
	});
});

// ─── Long-file oracle (issue #2005) ────────────────────────────────
// Same shape as the #2003/#2004 blocks above: the pinned analyzer run needs the
// CodeFlow checkout and a `git archive` of two commits, so the measurement stays
// out of this in-gate suite (the mirror that enforces the `<= 500` segment
// invariant per sibling lives in `test/long-file-refactor-2005.test.mts`).
// This block replays the recorded before/after and guards the record's shape.
const LONG_FILE_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "long-file-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; longFileCount: number };
	after: { commit: string; files: number; longFileCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

describe("long file metric oracle (issue #2005)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(LONG_FILE_BASELINE.provenance.issue, 2005);
		assert.strictEqual(
			LONG_FILE_BASELINE.provenance.filedCount,
			61,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(LONG_FILE_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(LONG_FILE_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			LONG_FILE_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(
			LONG_FILE_BASELINE.provenance.metric,
			/lines > 500/,
			"the metric names the exact predicate",
		);
		for (const [side, ref] of [
			["before", LONG_FILE_BASELINE.before],
			["after", LONG_FILE_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			LONG_FILE_BASELINE.after.commit,
			LONG_FILE_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			LONG_FILE_BASELINE.after.longFileCount < LONG_FILE_BASELINE.before.longFileCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			LONG_FILE_BASELINE.after.files > LONG_FILE_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(LONG_FILE_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of LONG_FILE_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust set and the embedded server.py, never omitting a leftover flag", () => {
		const deferred = LONG_FILE_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and server.py deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const serverPy = withFiles.find((d) => d.files!.every((f) => f.endsWith("server.py")));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(serverPy, "the embedded server.py is recorded as deferred");
		assert.ok(rust.files!.length >= 8);
		for (const rel of [...rust.files!, ...serverPy.files!]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!LONG_FILE_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});

	it("names the record and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/long-file-refactor-2005.test.mts",
			".pi/skills/audit-codeflow-analysis/references/long-file-2005.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});

	it("ties the recorded after envelope to the delivered tree", () => {
		// Recompute the pinned predicate over the delivered tracked tree with the
		// same mirror the per-sibling oracle uses, so the recorded count and the
		// deferral list cannot drift from the source they describe.
		const measured = measureWorktree(resolve(HERE, ".."));
		assert.strictEqual(
			measured.flagged.length,
			LONG_FILE_BASELINE.after.longFileCount,
			"after.longFileCount must equal the delivered tree's flagged files",
		);
		assert.strictEqual(
			measured.codeFiles,
			LONG_FILE_BASELINE.after.codeFiles,
			"after.codeFiles must equal the delivered tree's scored files",
		);
		const recordedDeferrals = LONG_FILE_BASELINE.deferred
			.flatMap((d) => d.files ?? [])
			.sort();
		assert.deepStrictEqual(
			measured.flagged,
			recordedDeferrals,
			"every file still flagged in the delivered tree must be a recorded deferral",
		);
	});
});
