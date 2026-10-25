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
