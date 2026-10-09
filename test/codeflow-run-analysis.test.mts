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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

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
    var blob = new Blob([JSON.stringify({ architectureIssues: [], duplicates: [{ files: ["a", "b"] }], layerViolations: [{ from: "UI", to: "DB" }], suggestions: [{ text: "split" }], marker: data.marker })], { type: "application/json" });
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

// The live run's own stats (`local/workspace-f4048b9b`): 5006 connections over
// 1026 files is the coupling input, 24 dead of 4890 functions the dead-code one.
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
		assert.ok(typeof env.analyzedAt === "number" && env.analyzedAt > 0, "analyzedAt must be epoch ms");
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
