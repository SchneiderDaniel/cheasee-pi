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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    var blob = new Blob([JSON.stringify({ architectureIssues: [], duplicates: [{ files: ["a", "b"] }], layerViolations: data.layerViolations || [{ from: "UI", to: "DB" }], suggestions: [{ text: "split" }], marker: data.marker, securityIssues: data.securityIssues || null })], { type: "application/json" });
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

function makeFixture(opts: { emitJson?: boolean; analyzerBlock?: string; analysisJs?: string | null } = {}): Fixture {
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
module.exports = {
  async analyze(options) {
    return { schemaVersion: 1, data: { marker: "FIXTURE", stats: { files: 1, functions: 1, loc: 1 } }, snapshot: {} };
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

function envelope(stdout: string): { markdown: string; json: string | null; analyzedAt: number } {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
}

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
		const kept = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"))
			.securityIssues.map((s: { path: string }) => s.path);
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
		const kept = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"))
			.securityIssues.map((s: { path: string }) => s.path);
		assert.deepStrictEqual(kept, ["escape.ts"], "a symlink target outside the snapshot must not be read");
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
		assert.strictEqual(JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8")).securityIssues, null);
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
