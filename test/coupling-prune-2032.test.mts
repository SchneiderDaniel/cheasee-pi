/**
 * Coupling-edge contracts (issue #2032).
 *
 * The premise these tests encode: CodeFlow's `N Highly Coupled` card is a count
 * over `data.connections` (`coupling[conn.target] > 8`), not an import count, so
 * splitting a file cannot lower it. What is asserted here:
 *
 *   1. `pruneCouplingEdges` drops only edges whose declaration the referencing
 *      file names nowhere outside comments and string literals, and is pure,
 *      deterministic and fail-closed;
 *   2. the producer prunes the edges and re-titles the card in the same run —
 *      both or neither, never a report that contradicts its own envelope;
 *   3. the measured before/after is pinned in `coupling-baseline-2032.json` and
 *      replayed by this file.
 *
 * Run with:
 *   node --experimental-strip-types --test test/coupling-prune-2032.test.mts
 */

import assert from "node:assert";

import { spawnSync } from "node:child_process";

import { createRequire } from "node:module";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CODEFLOW = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow");
const RUNNER = resolve(CODEFLOW, "run-analysis.mjs");
const fpFilter = createRequire(import.meta.url)(resolve(CODEFLOW, "fp-filter.js"));

/** A reader over an in-memory tree; a path absent from it reads as `null`. */
const reader =
	(files: Record<string, string>) =>
	(rel: string): string | null =>
		typeof rel === "string" && rel in files ? files[rel] : null;

const edge = (source: string, target: string, fn: string) => ({ source, target, fn });

// --- the producer fixture ---------------------------------------------------

const DERIVER = `
Parser.generateArchitectureIssues = function (d) {
  var seen = Object.create(null);
  (Array.isArray(d.connections) ? d.connections : []).forEach(function (c) {
    if (c && typeof c.target === "string") seen[c.target] = (seen[c.target] || 0) + 1;
  });
  var high = Object.keys(seen).filter(function (k) { return seen[k] > 8; });
  var kept = (d.issues || []).filter(function (i) { return !/Highly Coupled$/.test(String(i && i.title)); });
  if (high.length) kept.push({ type: "warning", title: high.length + " Highly Coupled" });
  return kept;
};`;

const ANALYZER = `const Parser = { functionKey: function (fn) { return fn.name; } };
function buildAnalysisData(opts) { return { files: [], stats: {}, marker: "FIXTURE" }; }`;

/** The analyzer block must keep the headless runner's slice markers. */
const analyzerBlock = (body: string): string => `// ===== CODEFLOW_ANALYZER_START =====
${body}
// ===== CODEFLOW_ANALYZER_END =====
// ===== CODEFLOW_METRICS_START =====
function calcHealth(data) { return { score: 100, grade: "A" }; }
// ===== CODEFLOW_METRICS_END =====`;

const GENERATE_REPORT = `
function generateReport(format) {
  if (format === "json") {
    var blob = new Blob([JSON.stringify({
      architectureIssues: (data.issues || []).map(function (i) { return { title: i.title }; }),
      marker: data.marker || null,
      stats: data.stats || null
    })], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "codeflow-report.json";
    a.click();
    URL.revokeObjectURL(url);
  } else if (format === "md") {
    var blob2 = new Blob(["# CodeFlow Analysis Report\\n\\nmarker=" + (data.marker || "") + "\\n"], { type: "text/markdown" });
    var url2 = URL.createObjectURL(blob2);
    var a2 = document.createElement("a");
    a2.href = url2;
    a2.download = "codeflow-report.md";
    a2.click();
    URL.revokeObjectURL(url2);
  }
}
`;

interface Fixture {
	uiDir: string;
	sourceDir: string;
	outDir: string;
}

function makeFixture(
	data: unknown,
	opts: { analyzer?: string; source?: Record<string, string> } = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "coupling-2032-"));
	const uiDir = join(root, "ui");
	const sourceDir = join(root, "src");
	const outDir = join(root, "out");
	mkdirSync(join(uiDir, "card", "lib"), { recursive: true });
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	for (const [rel, text] of Object.entries(opts.source ?? { "a.ts": "export const a = 1;\n" })) {
		mkdirSync(dirname(join(sourceDir, rel)), { recursive: true });
		writeFileSync(join(sourceDir, rel), text);
	}
	writeFileSync(
		join(uiDir, "index.html"),
		`<html><body><script type="text/babel">${analyzerBlock(`${ANALYZER}${opts.analyzer ?? DERIVER}`)}${GENERATE_REPORT}</script></body></html>`,
	);
	writeFileSync(
		join(uiDir, "card", "lib", "analysis.js"),
		`"use strict";\nmodule.exports = { async analyze() { return { data: ${JSON.stringify(data)} }; } };\n`,
	);
	return { uiDir, sourceDir, outDir };
}

interface Envelope {
	markdown: string;
	json: string | null;
	stats: Record<string, number> | null;
	terms: { coupling: number; deadCode: number } | null;
	coupling: { before: number; after: number; dropped: number } | null;
}

function runProducer(fx: Fixture): {
	code: number | null;
	env: Envelope | null;
	stdout: string;
	stderr: string;
} {
	const res = spawnSync(process.execPath, [RUNNER, fx.sourceDir, fx.uiDir, fx.outDir], {
		encoding: "utf-8",
	});
	const stdout = res.stdout ?? "";
	let env: Envelope | null = null;
	try {
		const lines = stdout.trim().split("\n");
		env = JSON.parse(lines[lines.length - 1]);
	} catch {
		env = null;
	}
	return { code: res.status, env, stdout, stderr: res.stderr ?? "" };
}

const titles = (fx: Fixture): string[] =>
	JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8")).architectureIssues.map(
		(i: { title: string }) => i.title,
	);

const BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "coupling-baseline-2032.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCoupled: number;
		filedAnalyzedAt: number;
	};
	before: {
		commit: string;
		files: number;
		functions: number;
		connections: number;
		coupled: number;
	};
	after: { ref: string; files: number; functions: number; connections: number; coupled: number };
	seam: { before: number; after: number; dropped: number; requires: string };
	reducedBy: { path: string; change: string }[];
	deferred: { reason: string; requires: string }[];
};

// --- phase 1: the edge predicate -------------------------------------------

describe("pruneCouplingEdges — a connection is not always a dependency (#2032)", () => {
	it("drops an edge whose target names the declaration only in a comment", () => {
		const data = { connections: [edge("b.ts", "a.ts", "slice")] };
		const out = fpFilter.pruneCouplingEdges(data, {
			readFile: reader({ "a.ts": "// see slice() for the argument order\nlet a = 1;\n" }),
		});
		assert.deepStrictEqual(out.connections, []);
		assert.strictEqual(out.dropped.length, 1);
		assert.deepStrictEqual(
			{ source: out.dropped[0].source, target: out.dropped[0].target },
			{ source: "b.ts", target: "a.ts" },
		);
		assert.ok(out.dropped[0].reason.length > 0, "a dropped edge must say why");
	});

	it("drops an edge whose target names the declaration only in a string literal", () => {
		const out = fpFilter.pruneCouplingEdges(
			{ connections: [edge("b.ts", "a.ts", "slice")] },
			{ readFile: reader({ "a.ts": 'const s = "calls slice()";\n' }) },
		);
		assert.deepStrictEqual(out.connections, []);
		assert.strictEqual(out.dropped.length, 1);
	});

	it("keeps an edge the target really calls", () => {
		const out = fpFilter.pruneCouplingEdges(
			{ connections: [edge("b.ts", "a.ts", "slice")] },
			{ readFile: reader({ "a.ts": "const head = slice(input, 0, 8);\n" }) },
		);
		assert.strictEqual(out.connections.length, 1);
		assert.deepStrictEqual(out.dropped, []);
	});

	it("keeps the surviving edges in input order and drops only the prose one", () => {
		const connections = [
			edge("b.ts", "keep1.ts", "alpha"),
			edge("b.ts", "prose.ts", "beta"),
			edge("b.ts", "keep2.ts", "gamma"),
		];
		const out = fpFilter.pruneCouplingEdges(
			{ connections },
			{
				readFile: reader({
					"keep1.ts": "alpha(1);\n",
					"prose.ts": "// beta() is the one that sorts\n",
					"keep2.ts": "gamma(2);\n",
				}),
			},
		);
		assert.deepStrictEqual(
			out.connections.map((c: { target: string }) => c.target),
			["keep1.ts", "keep2.ts"],
		);
		assert.deepStrictEqual(
			out.dropped.map((d: { target: string }) => d.target),
			["prose.ts"],
		);
	});

	it("keeps every edge it cannot disprove", () => {
		const connections = [
			edge("b.ts", "unknown.ts", "delta"), // the target file is unreadable
			{ source: "b.ts", target: "a.ts" } as unknown, // no declaration recorded
			{ source: "b.ts", target: "a.ts", fn: "slice", kind: "mdlink" }, // a link, not a call
			null,
			7,
			"x",
			{},
		];
		const out = fpFilter.pruneCouplingEdges(
			{ connections },
			{ readFile: reader({ "a.ts": "let a = 1;\n" }) },
		);
		assert.deepStrictEqual(out.connections, connections, "unreadable entries survive verbatim");
		assert.deepStrictEqual(out.dropped, []);
	});

	it("prunes nothing without a reader, and nothing without a connection list", () => {
		const connections = [edge("b.ts", "a.ts", "slice")];
		assert.deepStrictEqual(fpFilter.pruneCouplingEdges({ connections }, {}), {
			connections,
			dropped: [],
		});
		assert.deepStrictEqual(fpFilter.pruneCouplingEdges({ connections }, { readFile: null }), {
			connections,
			dropped: [],
		});
		assert.deepStrictEqual(fpFilter.pruneCouplingEdges({}, { readFile: () => "x" }), {
			connections: [],
			dropped: [],
		});
		assert.deepStrictEqual(fpFilter.pruneCouplingEdges({ connections: "oops" }, {}), {
			connections: [],
			dropped: [],
		});
	});

	it("is pure, and does not apply the analyzer's fan-in ceiling", () => {
		const connections = Array.from({ length: 9 }, (_, i) => edge("b.ts", `t${i}.ts`, `fn${i}`));
		const files = Object.fromEntries(
			connections.map((c: { target: string; fn: string }) => [c.target, `${c.fn}();\n`]),
		);
		const data = { connections };
		const before = JSON.stringify(data);
		const out = fpFilter.pruneCouplingEdges(data, { readFile: reader(files) });
		assert.strictEqual(JSON.stringify(data), before, "the input must not be mutated");
		assert.notStrictEqual(out.connections, data.connections, "the result is a new array");
		assert.deepStrictEqual(
			out.connections,
			connections,
			"nine real edges stay nine: the threshold is the caller's, not the predicate's",
		);
	});

	it("is deterministic and idempotent", () => {
		const data = {
			connections: [edge("b.ts", "a.ts", "slice"), edge("b.ts", "c.ts", "real")],
		};
		const opts = { readFile: reader({ "a.ts": "// slice()\n", "c.ts": "real();\n" }) };
		const first = fpFilter.pruneCouplingEdges(data, opts);
		const second = fpFilter.pruneCouplingEdges(data, opts);
		assert.deepStrictEqual(first, second);
		const again = fpFilter.pruneCouplingEdges({ connections: first.connections }, opts);
		assert.deepStrictEqual(again.dropped, []);
		assert.deepStrictEqual(again.connections, first.connections);
	});
});

// --- phase 2: producer wiring ----------------------------------------------

describe("run-analysis — pruned coupling edges and the re-derived card (#2032)", () => {
	// Two referencing files: `a.ts` collects 10 edges of which four name their
	// declaration only in a comment, `c.ts` collects nine real ones. So the card
	// flags 2 files before the prune and 1 after.
	const source = {
		"a.ts": [
			...Array.from({ length: 6 }, (_, i) => `const r${i} = slice${i}(x);`),
			...Array.from({ length: 4 }, (_, i) => `// slice${i + 6}() sorts the slice`),
		].join("\n"),
		"c.ts": Array.from({ length: 9 }, (_, i) => `const r${i} = parse${i}(x);`).join("\n"),
	};

	const data = {
		marker: "COUPLING",
		stats: { files: 20, functions: 20, connections: 19, dead: 0, loc: 10 },
		issues: [{ type: "warning", title: "2 Highly Coupled" }],
		connections: [
			...Array.from({ length: 10 }, (_, i) => edge(`def${i}.ts`, "a.ts", `slice${i}`)),
			...Array.from({ length: 9 }, (_, i) => edge("defc.ts", "c.ts", `parse${i}`)),
		],
	};

	it("prunes prose-only edges, re-titles the card and reports the drop", () => {
		const fx = makeFixture(data, { source });
		const { code, env, stderr } = runProducer(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.deepStrictEqual(env?.coupling, { before: 2, after: 1, dropped: 4 });
		assert.ok(existsSync(join(fx.outDir, "report.md")), "the markdown artifact must exist");
		assert.ok(existsSync(join(fx.outDir, "report.json")), "the JSON artifact must exist");
		assert.deepStrictEqual(titles(fx), ["1 Highly Coupled"], "the card follows the pruned count");
		assert.match(
			stderr,
			/coupling-prune: dropped 4 non-dependency edge\(s\)/,
			"the drop must be visible",
		);
		assert.strictEqual(env?.stats?.connections, 19, "stats stay the analyzer's own numbers");
	});

	it("never carries the card's title as a literal in repo code", () => {
		for (const rel of ["run-analysis.mjs", "fp-filter.js"]) {
			const text = readFileSync(resolve(CODEFLOW, rel), "utf-8");
			assert.ok(
				!/Highly Coupled/.test(text),
				`${rel} must not restate the analyzer's title: it can only come from the deriver port`,
			);
		}
	});

	it("prunes nothing when the run has no architecture deriver", () => {
		const fx = makeFixture(data, { source, analyzer: "" });
		const { code, env, stderr } = runProducer(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.strictEqual(env?.coupling, null, "no deriver means no measurement to report");
		assert.deepStrictEqual(titles(fx), ["2 Highly Coupled"], "the card stands verbatim");
		assert.ok(!/coupling-prune/.test(stderr), "nothing was pruned, so nothing is logged");
	});

	it("prunes nothing when the connection list is not a list", () => {
		const fx = makeFixture({ ...data, connections: "oops" }, { source });
		const { code, env, stderr } = runProducer(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.strictEqual(env?.coupling, null);
		assert.deepStrictEqual(titles(fx), ["2 Highly Coupled"]);
		assert.ok(
			existsSync(join(fx.outDir, "report.md")) && existsSync(join(fx.outDir, "report.json")),
		);
	});

	it("fails closed with no artifact when the deriver throws", () => {
		const fx = makeFixture(data, {
			source,
			analyzer: `\nParser.generateArchitectureIssues = function () { throw new Error("deriver exploded"); };`,
		});
		const { code, stderr } = runProducer(fx);

		assert.notStrictEqual(code, 0);
		assert.match(stderr, /deriver exploded/);
		assert.ok(stderr.length <= 4096, "stderr must stay bounded");
		assert.ok(!existsSync(join(fx.outDir, "report.md")), "no half-pruned markdown");
		assert.ok(!existsSync(join(fx.outDir, "report.json")), "no half-pruned JSON");
	});

	it("replays the recorded before/after envelope", () => {
		const stats = {
			files: BASELINE.after.files,
			functions: BASELINE.after.functions,
			connections: BASELINE.after.connections,
			dead: 24,
			loc: 1,
		};
		const fx = makeFixture({ marker: "BASELINE", stats });
		const { code, env, stderr } = runProducer(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		assert.deepStrictEqual(env?.stats, stats, "stats pass through un-remapped");
		assert.strictEqual(env?.coupling, null, "a tree with no connections is not measured");
	});
});

// --- phase 4: the recorded measurement -------------------------------------

describe("coupling register (issue #2032)", () => {
	it("pins the analyzer ref and the metric it counts", () => {
		const mirror = readFileSync(resolve(HERE, "fixtures", "long-file-mirror.mts"), "utf-8");
		assert.ok(mirror.includes(BASELINE.provenance.ref), "the ref must be the single pinned one");
		assert.strictEqual(BASELINE.provenance.issue, 2032);
		assert.strictEqual(BASELINE.provenance.filedCoupled, 199);
		assert.strictEqual(BASELINE.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(BASELINE.provenance.metric, /connections/);
		assert.match(BASELINE.provenance.metric, /> 8/);
	});

	it("records an immutable base commit and the delivered branch", () => {
		assert.match(BASELINE.before.commit, /^[0-9a-f]{40}$/);
		assert.ok(BASELINE.after.ref.length > 0, "the delivered tree must be named");
		// A branch commit id only exists after the pipeline commits; the #2031 and
		// #2034 registers record the branch for the same reason.
		assert.ok(
			!/^[0-9a-f]{40}$/.test(BASELINE.after.ref) || BASELINE.after.ref !== BASELINE.before.commit,
			"the delivered tree is not the base tree",
		);
		assert.ok(BASELINE.after.coupled < BASELINE.seam.before + 1, "no regression on the base");
	});

	it("records a measured drop, not a projection", () => {
		assert.strictEqual(BASELINE.seam.before, BASELINE.after.coupled);
		assert.ok(BASELINE.seam.after < BASELINE.seam.before, "the seam must lower the count");
		assert.ok(BASELINE.seam.dropped > 0, "and it must name how many edges went");
		assert.ok(BASELINE.after.connections <= BASELINE.before.connections + 8);
		assert.ok(BASELINE.seam.requires.length > 0, "the seam must name what it needs to be live");
	});

	it("cites only tracked, scored files as a reduction source", () => {
		for (const entry of BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(ROOT, entry.path)), `${entry.path} must exist`);
			assert.ok(!entry.path.endsWith(".mts"), `${entry.path}: the analyzer never scores .mts`);
			assert.ok(entry.change.length > 0, `${entry.path} must say what changed`);
		}
		assert.strictEqual(
			new Set(BASELINE.reducedBy.map((e) => e.path)).size,
			BASELINE.reducedBy.length,
			"each path is listed once",
		);
	});

	it("records every leader it left alone with what it would need", () => {
		assert.ok(BASELINE.deferred.length >= 2);
		for (const entry of BASELINE.deferred) {
			assert.ok(entry.reason.length > 0, "a deferral must say why");
			assert.ok(entry.requires.length > 0, "a deferral must say what would unlock it");
		}
		const text = JSON.stringify(BASELINE.deferred);
		assert.match(text, /cargo/, "the Rust UI sources cannot be verified in-gate");
	});

	it("documents the metric, the reproduction and what was left alone", () => {
		const doc = readFileSync(
			resolve(ROOT, ".pi/skills/audit-codeflow-analysis/references/coupling-2032.md"),
			"utf-8",
		);
		for (const needle of [
			"## The metric",
			"## Reproduction",
			"## Before / after",
			"## What was left alone",
			BASELINE.before.commit,
			"not an import count",
			"generateArchitectureIssues",
		]) {
			assert.ok(doc.includes(needle), `the record must carry ${needle}`);
		}
	});
});
