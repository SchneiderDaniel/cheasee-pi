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
import { measureComplexity } from "./fixtures/complexity-mirror.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");

// The analyzer stand-in the fixture index.html embeds. Kept in a .txt fixture
// so CodeFlow's analyzer does not parse `buildAnalysisData` / `calcHealth` as
// production functions and flag them as cross-file duplicates.
const ANALYZER_BLOCK = readFileSync(
	resolve(HERE, "fixtures", "codeflow-analyzer-block.txt"),
	"utf-8",
);

// generateReport mirrors the UI export seam: it builds a Blob and hands it to
// URL.createObjectURL, which the runner stubs to capture the bytes.
function generateReportBody(emitJson = true, emitDead = false): string {
	return `
function generateReport(format) {
  if (format === "json"${emitJson ? "" : " && false"}) {
    var blob = new Blob([JSON.stringify({ architectureIssues: data.architectureIssues || [], duplicates: data.duplicates || [{ files: ["a", "b"] }], layerViolations: data.layerViolations || [{ from: "UI", to: "DB" }], suggestions: [{ text: "split" }], marker: data.marker, securityIssues: data.securityIssues || null${emitDead ? ", unusedFunctions: data.deadFunctions || null, stats: data.stats || null" : ""}})], { type: "application/json" });
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
		emitDead?: boolean;
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
		`<html><body><script type="text/babel">${block}${generateReportBody(opts.emitJson !== false, opts.emitDead === true)}</script></body></html>`,
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
					{
						severity: "low",
						title: "Code Comments",
						description: "Unresolved marker.",
						path: "src/widget.test.ts",
						line: 4,
						code: "",
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
			/fp-filter: suppressed 2 security issue\(s\), 2 layer violation\(s\), 1 hygiene finding\(s\), 0 unused function\(s\), 0 duplicate group\(s\)\n/,
			"suppression must be observable, never silent",
		);
	});

	it("drops dead functions the snapshot still references and recounts stats.dead", () => {
		const fx = makeFixture({
			emitDead: true,
			analysisJs: analysisJs({
				marker: "DEAD",
				files: [{ path: "use.ts" }, { path: "def.ts" }],
				stats: { files: 2, functions: 3, dead: 2 },
				securityIssues: [
					{ severity: "high", title: "Shell Command Execution", code: "", path: "def.ts" },
				],
				deadFunctions: [
					{ name: "liveCall", file: "def.ts", line: 1 },
					{ name: "ghost", file: "def.ts", line: 9 },
				],
			}),
		});
		writeFileSync(join(fx.sourceDir, "def.ts"), "export function liveCall() { return 1; }\n");
		writeFileSync(
			join(fx.sourceDir, "use.ts"),
			"import { liveCall } from './def.ts';\nliveCall();\n",
		);
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.match(
			stderr,
			/fp-filter: suppressed 1 security issue\(s\), 0 layer violation\(s\), 0 hygiene finding\(s\), 1 unused function\(s\), 0 duplicate group\(s\)\n/,
			"the dead count rides alongside the others, which keep their own",
		);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(
			json.unusedFunctions.map((f: { name: string }) => f.name),
			["ghost"],
			"only the symbol no snapshot file references may be reported as unused",
		);
		assert.strictEqual(
			json.stats.dead,
			json.unusedFunctions.length,
			"the summary count must agree",
		);
	});

	it("drops LOW hygiene findings only on non-shipping artifacts and reports them", () => {
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "HYGIENE",
				stats: { files: 2, functions: 1, loc: 2 },
				securityIssues: [
					{
						severity: "low",
						title: "Code Comments",
						description: "Unresolved marker.",
						path: "src/widget.test.ts",
						line: 1,
						code: "",
					},
					{
						severity: "low",
						title: "Debug Statements",
						description: "Console call.",
						path: ".pi/extensions/x/test/index.test.mts",
						line: 2,
						code: "",
					},
					{
						severity: "low",
						title: "Code Comments",
						description: "Unresolved marker.",
						path: "src/config.ts",
						line: 3,
						code: "",
					},
				],
				layerViolations: [],
			}),
		});
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(
			json.securityIssues.map((s: { path: string }) => s.path),
			["src/config.ts"],
			"LOW hygiene on shipping source is real work, not an artifact",
		);
		assert.strictEqual(
			stderr,
			"fp-filter: suppressed 0 security issue(s), 0 layer violation(s), 2 hygiene finding(s), 0 unused function(s), 0 duplicate group(s)\n",
		);
	});

	it("suppresses aggregate duplicate groups before the export and reports the count", () => {
		const pairwise = {
			type: "code",
			name: "readSettingsCodeflowPort, readSettingsUIPort",
			files: [{ file: "b.ts" }],
		};
		const fx = makeFixture({
			analysisJs: analysisJs({
				marker: "DUPES",
				stats: { files: 2, functions: 1, loc: 2, duplicates: 2 },
				duplicates: [
					{ type: "code", name: "withEnv, exec, cacheGet", files: [{ file: "a.ts" }] },
					pairwise,
				],
			}),
		});
		const { code, stdout, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(json.duplicates, [pairwise], "only the pairwise group may survive");
		assert.strictEqual(
			envelope(stdout).stats?.duplicates,
			1,
			"stats.duplicates moves with the survivors",
		);
		assert.match(
			stderr,
			/fp-filter: suppressed 0 security issue\(s\), 0 layer violation\(s\), 0 hygiene finding\(s\), 0 unused function\(s\), 1 duplicate group\(s\)\n/,
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
		// The envelope records the #2005 delivery (17). A later refactor may only
		// move declarations out of a recorded long file — #2036 split eleven of the
		// seventeen below 500 segments and added one new long module (the
		// `session.rs` relay), which is recorded in the deferrals below — so the
		// measured count can fall but must never exceed the recorded envelope.
		assert.ok(
			measured.flagged.length <= LONG_FILE_BASELINE.after.longFileCount,
			"the delivered tree must not carry more long files than the recorded envelope",
		);
		// The recorded envelope is anchored to an ancestor commit, so the delivered
		// tree can only have gained scored files since; a lower count means code was
		// deleted, which is the drift this guards against.
		assert.ok(
			measured.codeFiles >= LONG_FILE_BASELINE.after.codeFiles,
			"the delivered tree must still carry the recorded scored files",
		);
		const recordedDeferrals = LONG_FILE_BASELINE.deferred.flatMap((d) => d.files ?? []).sort();
		for (const rel of measured.flagged) {
			assert.ok(
				recordedDeferrals.includes(rel),
				`${rel} is flagged in the delivered tree but is not a recorded deferral`,
			);
		}
	});
});

// ─── High-complexity-files oracle (issue #2033) ─────────────────────
// Same shape as the #2005 block: the pinned analyzer run needs the CodeFlow
// checkout and a `git archive` of two commits, so the measurement stays out of
// this in-gate suite (the mirror that enforces the `<= 30` per-sibling
// invariant lives in `test/complexity-refactor-2033.test.mts`). This block
// replays the recorded before/after and guards the record's shape.
const COMPLEXITY_2033 = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "complexity-baseline-2033.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	filedBaseline: { commit: string; files: number; codeFiles: number; criticalCount: number };
	before: { commit: string; files: number; codeFiles: number; criticalCount: number };
	after: { criticalCount: number; expectedDrop: number };
	partition: { scored: number; critical: number; notScored: number; belowCeiling: number };
	reducedBy: Array<{ path: string; before: number; parts: number; siblings: string[] }>;
	deferred: Record<string, { reason: string; requires: string }>;
	notScored: string[];
};

describe("complexity metric oracle (issue #2033)", () => {
	it("records a real drop between two measured trees on the pinned analyzer", () => {
		assert.strictEqual(COMPLEXITY_2033.provenance.issue, 2033);
		assert.strictEqual(
			COMPLEXITY_2033.provenance.filedCount,
			286,
			"the issue's filed count is a superset, not the analyzer's flag set",
		);
		assert.strictEqual(COMPLEXITY_2033.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(COMPLEXITY_2033.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			COMPLEXITY_2033.provenance.metric,
			/level === "critical"/,
			"the metric names the critical predicate",
		);
		assert.match(COMPLEXITY_2033.provenance.metric, /> 30/, "the metric names the ceiling");
		for (const [side, ref] of [
			["filedBaseline", COMPLEXITY_2033.filedBaseline],
			["before", COMPLEXITY_2033.before],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			COMPLEXITY_2033.before.commit,
			COMPLEXITY_2033.filedBaseline.commit,
			"the branch base advanced past the filed baseline; both are recorded",
		);
		assert.ok(
			COMPLEXITY_2033.after.criticalCount < COMPLEXITY_2033.before.criticalCount,
			"the flagged-file count must fall",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.strictEqual(COMPLEXITY_2033.reducedBy.length, 12, "the 12 Wave-1 families");
		for (const family of COMPLEXITY_2033.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", family.path)), `missing: ${family.path}`);
			assert.ok(!family.path.endsWith(".mts"), `${family.path} is test-only (never scored)`);
			assert.strictEqual(family.parts, 1 + family.siblings.length);
			for (const rel of family.siblings) {
				assert.ok(existsSync(resolve(HERE, "..", rel)), `missing sibling: ${rel}`);
			}
		}
	});

	it("defers every leftover flag with a requires pointer, never omitting one", () => {
		const deferred = Object.entries(COMPLEXITY_2033.deferred);
		assert.strictEqual(
			deferred.length,
			COMPLEXITY_2033.after.criticalCount,
			"the deferral list is exactly the remaining flag set",
		);
		for (const [rel, entry] of deferred) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(entry.reason.length > 0, `${rel} states no reason`);
			assert.ok(entry.requires.length > 0, `${rel} states no requires pointer`);
		}
		const rust = deferred.filter(([rel]) => rel.endsWith(".rs"));
		assert.ok(rust.length >= 8, "the Rust UI set is recorded as deferred");
		assert.ok(
			rust.every(([, e]) => /Rust toolchain/.test(e.requires)),
			"the Rust deferral names the missing toolchain",
		);
	});

	it("records the unscorable .mts paths as such", () => {
		assert.strictEqual(COMPLEXITY_2033.notScored.length, COMPLEXITY_2033.partition.notScored);
		assert.ok(COMPLEXITY_2033.notScored.length > 0);
		for (const rel of COMPLEXITY_2033.notScored) {
			assert.ok(rel.endsWith(".mts"), `${rel} is not a .mts`);
			assert.strictEqual(
				rel in COMPLEXITY_2033.deferred,
				false,
				`${rel} is both notScored and deferred`,
			);
		}
	});

	it("names the record and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/complexity-refactor-2033.test.mts",
			".pi/skills/audit-codeflow-analysis/references/complexity-2033.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});

	it("ties the recorded after envelope to the delivered tree", () => {
		// Recompute the pinned predicate over the delivered tree with the same mirror
		// the per-family oracle uses, so the recorded count and the deferral list
		// cannot drift from the source they describe.
		const measured = measureComplexity(resolve(HERE, ".."));
		assert.strictEqual(
			measured.flagged.length,
			COMPLEXITY_2033.after.criticalCount,
			"the recorded after count must equal the measured flag count",
		);
		assert.deepStrictEqual(
			measured.flagged,
			Object.keys(COMPLEXITY_2033.deferred).sort(),
			"every measured flag must be a recorded deferral",
		);
		assert.ok(
			measured.flagged.length < COMPLEXITY_2033.before.criticalCount,
			"the delivered tree carries fewer flags than the branch base",
		);
	});
});

// ─── VBA god module oracle (issue #2006) ──────────────────────────
// Same shape as the #2003/#2004/#2005 blocks above: the pinned analyzer run
// needs the CodeFlow checkout and a `git archive` of two commits, so the
// measurement stays out of this in-gate suite (the mirror that enforces the
// `<= 20` and `<= 15` per-sibling invariants lives in
// `test/vba-god-module-refactor-2006.test.mts`). This block replays the
// recorded before/after and guards the record's shape.
const VBA_GOD_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "vba-god-module-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; vbaGodModuleCount: number };
	after: { commit: string; files: number; vbaGodModuleCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

describe("vba god module metric oracle (issue #2006)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(VBA_GOD_BASELINE.provenance.issue, 2006);
		assert.strictEqual(
			VBA_GOD_BASELINE.provenance.filedCount,
			44,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(VBA_GOD_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(VBA_GOD_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			VBA_GOD_BASELINE.provenance.metric,
			/functions\.length > 20/,
			"the metric names the exact predicate",
		);
		assert.match(
			VBA_GOD_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		for (const [side, ref] of [
			["before", VBA_GOD_BASELINE.before],
			["after", VBA_GOD_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			VBA_GOD_BASELINE.after.commit,
			VBA_GOD_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			VBA_GOD_BASELINE.after.vbaGodModuleCount < VBA_GOD_BASELINE.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			VBA_GOD_BASELINE.after.files > VBA_GOD_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(VBA_GOD_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of VBA_GOD_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust set and server.py, never citing one path twice", () => {
		const deferred = VBA_GOD_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and server.py deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const serverPy = withFiles.find((d) =>
			d.files!.includes("cmd/cheasee-pi/embedded/docker/codeflow/server.py"),
		);
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(serverPy, "the embedded server.py is recorded as deferred");
		for (const rel of withFiles.flatMap((d) => d.files!)) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!VBA_GOD_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		const files = VBA_GOD_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.strictEqual(
			VBA_GOD_BASELINE.before.vbaGodModuleCount,
			VBA_GOD_BASELINE.reducedBy.length + files.length,
			"the base count must equal reduced + deferred",
		);
		assert.strictEqual(
			VBA_GOD_BASELINE.after.vbaGodModuleCount,
			files.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
	});

	it("names the per-sibling oracle and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/vba-god-module-refactor-2006.test.mts",
			".pi/skills/audit-codeflow-analysis/references/vba-god-module-2006.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});
});

// ─── VBA god module oracle (issue #2036) ──────────────────────────
// The re-filed `VBA God Module` metric. This block replays the recorded
// envelope and guards its shape; the per-sibling structural oracle lives in
// `test/vba-god-module-refactor-2036.test.mts`.
const VBA_GOD_2036_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "vba-god-module-baseline-2036.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; codeFiles: number; vbaGodModuleCount: number };
	after: { ref: string; codeFiles: number; vbaGodModuleCount: number };
	baseAdvance: { resolvedFiles: string[] };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

describe("vba god module metric oracle (issue #2036)", () => {
	it("records a real drop on the pinned analyzer", () => {
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.issue, 2036);
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.filedCount, 25);
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(VBA_GOD_2036_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			VBA_GOD_2036_BASELINE.provenance.metric,
			/functions\.length > 20/,
			"the metric names the exact predicate",
		);
		assert.match(
			VBA_GOD_2036_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(VBA_GOD_2036_BASELINE.before.commit, /^[0-9a-f]{40}$/, "immutable base commit");
		assert.ok(
			VBA_GOD_2036_BASELINE.after.vbaGodModuleCount <
				VBA_GOD_2036_BASELINE.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			VBA_GOD_2036_BASELINE.after.codeFiles > VBA_GOD_2036_BASELINE.before.codeFiles,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(VBA_GOD_2036_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of VBA_GOD_2036_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(!rel.endsWith(".mts"), `${rel} is test-only: the analyzer never counts a .mts`);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		const files = VBA_GOD_2036_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.strictEqual(
			VBA_GOD_2036_BASELINE.before.vbaGodModuleCount,
			VBA_GOD_2036_BASELINE.reducedBy.length +
				files.length +
				VBA_GOD_2036_BASELINE.baseAdvance.resolvedFiles.length,
			"the base count must equal reduced + deferred + resolved after the pinned base",
		);
		assert.strictEqual(
			VBA_GOD_2036_BASELINE.after.vbaGodModuleCount,
			files.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
	});

	it("names the per-sibling oracle and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/vba-god-module-refactor-2036.test.mts",
			".pi/skills/audit-codeflow-analysis/references/vba-god-module-2036.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});
});
