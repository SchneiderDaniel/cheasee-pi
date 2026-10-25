import assert from "node:assert";

import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");

const ANALYZER_BLOCK = readFileSync(
	resolve(HERE, "fixtures", "codeflow-analyzer-block.txt"),
	"utf-8",
);

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

function analysisJs(data: unknown): string {
	return `"use strict";
module.exports = {
  async analyze() {
    return { schemaVersion: 1, data: ${JSON.stringify(data)}, snapshot: {} };
  },
};
`;
}

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

const COMPLEXITY_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "complexity-baseline.json"), "utf-8"),
) as {
	provenance: { issue: number; ref: string; metric: string; filedCount: number };
	before: { commit: string; files: number; complexityCount: number };
	after: { commit: string; files: number; complexityCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

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
});
