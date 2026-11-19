// ─── Dashboard score == report score (issue #2147) ─────────────────
// The bug: a fresh analysis showed 72/C on the dashboard while the headless
// report for the same committed tree said 94/A. The browser-side filter ran
// inside `generateReport()`, i.e. *after* the dashboard had already scored the raw
// analyzer output. The filter now runs once at analysis completion, so the score,
// the tabs and the exports read one filtered snapshot.
//
// This file pins the user-visible outcome, not the mechanism:
//
//   * parity — the dashboard's own score expression (recorded verbatim from the
//     pinned upstream page) and the report produced by the pinned upstream
//     `generateReport()` return the same number and grade on the same data;
//   * anti-vacuous — the raw analysis still scores below an A, so the parity
//     assertion cannot pass on unfiltered data;
//   * the issue's numbers — the recorded snapshot scores 94/A on both paths;
//   * the served page end to end — the rewritten seam, executed in a vm with the
//     real policy and glue, renders the filtered score and exports the same one.
//
// Run: node --experimental-strip-types --test test/codeflow-dashboard-score-parity-2147.test.mts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CODEFLOW = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow");
const FILTER = resolve(CODEFLOW, "fp-filter.js");
const MODULE_DIR = resolve(CODEFLOW, "fp-filter");
const GLUE = resolve(MODULE_DIR, "browser-glue.js");
const RUNNER = resolve(CODEFLOW, "run-analysis.mjs");
const UI_REWRITES_PY = resolve(CODEFLOW, "ui_rewrites.py");
const SEAM_FIXTURE = resolve(HERE, "fixtures/codeflow-dashboard-seam.html");
const GENERATOR = resolve(HERE, "fixtures/generate-dashboard-seam-fixture.mjs");
const FIXTURE = resolve(HERE, "fixtures/codeflow-real-analysis-fp.json");

/** The score the recorded snapshot must produce on both paths (issue #2147). */
const EXPECTED_SCORE = 94;
const EXPECTED_GRADE = "A";

const requireCjs = createRequire(import.meta.url);
const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** The recorded upstream blocks, keyed by id. */
function seamBlocks(): Record<string, string> {
	const text = readFileSync(SEAM_FIXTURE, "utf-8");
	const blocks: Record<string, string> = {};
	for (const m of text.matchAll(/^;@@RECORDED:([\w-]+)@@\n([\s\S]*?)\n;@@END:\1@@$/gm)) {
		blocks[m[1]] = m[2];
	}
	return blocks;
}

/** The served seam, produced by `ui_rewrites.py` itself (never re-implemented). */
function rewrittenSeam(input: string): string | null {
	try {
		return execFileSync(
			"python3",
			[
				"-c",
				[
					"import runpy, sys",
					"m = runpy.run_path(sys.argv[1])",
					"pat, repl = m['_UI_REWRITES'][0]",
					"sys.stdout.buffer.write(pat.sub(lambda _: repl, sys.stdin.buffer.read()))",
				].join("\n"),
				UI_REWRITES_PY,
			],
			{ input, encoding: "utf-8", maxBuffer: 1 << 26 },
		);
	} catch {
		return null;
	}
}

/**
 * The recorded analyzer snapshot in the shape the served page holds it: `content`
 * freed, the text on `piFpSource`. Only the cites a finding names carry text, so
 * the replay reads a handful of files instead of the whole tree.
 */
function recordedPageData(): Record<string, any> {
	const recorded = JSON.parse(readFileSync(FIXTURE, "utf-8"));
	const cited = new Set<string>([
		...recorded.securityIssues.map((s: { path?: string }) => String(s.path)),
		...recorded.deadFunctions.map((f: { file?: string }) => String(f.file)),
	]);
	const source = (rel: string): string | null => {
		if (!cited.has(rel)) return null;
		try {
			return readFileSync(resolve(ROOT, rel), "utf-8");
		} catch {
			return null;
		}
	};
	// `generateReport` also walks patterns, folders, the call graph and the
	// function index. The recording carries no duplicate groups; the empties keep
	// the *upstream* export function runnable without inventing findings.
	return {
		...recorded,
		patterns: [],
		fnStats: {},
		folders: [],
		duplicates: recorded.duplicates ?? [],
		files: recorded.files.map((f: { path: string }) => ({
			path: f.path,
			content: null,
			piFpSource: source(f.path),
			functions: [],
		})),
	};
}

/**
 * A page-shaped sandbox: the pinned upstream `calcHealth`, `generateReport` and
 * dashboard score expression, the real policy and glue, stubbed export sinks.
 */
function pageSandbox(data: Record<string, any>, opts: { deriver?: boolean } = {}) {
	const logs: string[] = [];
	const captured = new Map<string, string>();
	let pending = "";
	const sandbox: Record<string, any> = {
		console: { info: (m: string) => logs.push(String(m)), error() {}, log() {} },
		calcHealth,
		// The dashboard memoises `calcHealth(data)`; reading it is the render.
		useMemo: (fn: () => unknown) => fn(),
		// The page's own parser: the export needs `functionKey`, and the filter's
		// deriver port is `Parser.generateSuggestions`.
		Parser:
			opts.deriver === false
				? undefined
				: {
						functionKey: (fn: { name: string }) => fn.name,
						generateSuggestions: (filtered: { stats: { dead: number } }) => [
							{
								title: "Remove Dead Code",
								desc: `${filtered.stats.dead} unused functions detected.`,
							},
						],
					},
		getAnalysisSourceLabel: () => "workspace",
		repoInfo: { name: "workspace" },
		localSourceKind: "folder",
		showNotification() {},
		Blob: function (this: any, parts: string[]) {
			this.parts = parts;
		},
		URL: {
			createObjectURL(blob: { parts?: string[] }) {
				pending = (blob.parts ?? []).join("");
				return "blob:codeflow-report";
			},
			revokeObjectURL() {},
		},
		document: {
			createElement() {
				return {
					href: "",
					download: "",
					click(this: { download: string }) {
						if (this.download) captured.set(this.download, pending);
					},
				};
			},
		},
		buildAnalysisData: () => Promise.resolve(data),
	};
	vm.createContext(sandbox);
	for (const name of readdirSync(MODULE_DIR, { recursive: true }) as string[]) {
		if (!name.endsWith(".js")) continue;
		vm.runInContext(readFileSync(resolve(MODULE_DIR, name), "utf-8"), sandbox, {
			filename: `${name}.js`,
		});
	}
	vm.runInContext(readFileSync(FILTER, "utf-8"), sandbox, { filename: "fp-filter.js" });
	vm.runInContext(readFileSync(GLUE, "utf-8"), sandbox, { filename: "browser-glue.js" });
	return { sandbox, logs, captured };
}

/** Score the way the dashboard does: through the recorded `useMemo` expression. */
function dashboardScore(data: Record<string, any>): { score: number; grade: string } {
	const { sandbox } = pageSandbox(data);
	sandbox.data = data;
	vm.runInContext(seamBlocks()["dashboard-score"], sandbox, { filename: "dashboard-score.js" });
	return sandbox.health;
}

/** Export through the recorded upstream `generateReport`, capturing its blob. */
function exportedReport(data: Record<string, any>): { md: string; json: any } {
	const blocks = seamBlocks();
	const { sandbox, captured } = pageSandbox(data);
	sandbox.data = data;
	vm.runInContext(blocks["generate-report"], sandbox, { filename: "generate-report.js" });
	sandbox.generateReport("md");
	sandbox.generateReport("json");
	const md = captured.get("codeflow-report.md");
	assert.ok(md && md.length > 0, "the upstream export must emit a markdown report");
	const json = captured.get("codeflow-report.json");
	assert.ok(json, "the upstream export must emit the structured report");
	return { md: md as string, json: JSON.parse(json as string) };
}

/** The policy applied once, as the seam does it. */
async function filtered(data: Record<string, any>, opts: Record<string, any> = {}) {
	const filter = requireCjs(FILTER);
	const glue = requireCjs(GLUE);
	glue.applyFalsePositiveFilter(data, { console: { info() {} }, ...opts });
	return { data, filter };
}

describe("dashboard score parity #2147 — recorded upstream page", () => {
	it("scores the dashboard and the export identically after filtering", async () => {
		const data = await filtered(recordedPageData()).then((r) => r.data);
		const dashboard = dashboardScore(data);
		const report = exportedReport(data);

		assert.equal(
			dashboard.score,
			report.json.summary.healthScore,
			"the visible score must be the score the export reports",
		);
		assert.equal(dashboard.grade, report.json.summary.healthGrade, "and the same grade");
		assert.equal(
			dashboard.score,
			EXPECTED_SCORE,
			`expected the corrected score, got ${dashboard.score}`,
		);
		assert.equal(dashboard.grade, EXPECTED_GRADE);
	});

	it("cannot pass on unfiltered data (the recorded false positives still cost a grade)", () => {
		const raw = recordedPageData();
		const before = calcHealth(raw);
		assert.ok(before.score < 90, `the raw snapshot must not already score an A: ${before.score}`);
		assert.notEqual(before.grade, "A");
		// And the same expression the dashboard uses agrees.
		assert.equal(dashboardScore(raw).score, before.score);
	});

	it("reproduces the issue's numbers: raw 74/C on screen, 94/A after the fix", async () => {
		const data = recordedPageData();
		const before = dashboardScore(data);
		assert.equal(before.score, 74, "the raw dashboard score the issue reports (74 here, 72 live)");

		const glue = requireCjs(GLUE);
		glue.applyFalsePositiveFilter(data, { console: { info() {} } });

		const after = dashboardScore(data);
		const report = exportedReport(data);
		assert.equal(after.score, 94, "the filtered snapshot scores 94 on the dashboard");
		assert.equal(after.grade, "A");
		assert.equal(report.json.summary.healthScore, after.score);
		assert.equal(report.json.summary.healthGrade, after.grade);
		assert.equal(report.json.summary.highSecurityIssues, 0, "no HIGH hit may be reported");
		assert.ok(
			report.md.includes(`| Health Score | ${after.score}/100 (${after.grade}) |`),
			"the markdown report must carry the same score line",
		);
		// The two MEDIUM command-execution hits outside this repo's policy stay: the
		// issue's "2 medium, 0 high" shape.
		const highs = data.securityIssues.filter(
			(s: { severity: string }) => String(s.severity).toLowerCase() === "high",
		);
		assert.equal(highs.length, 0);
	});

	it("keeps both paths equal when there is nothing to suppress", async () => {
		const clean = {
			securityIssues: [
				{
					severity: "low",
					title: "Code Comments",
					desc: "marker in shipping code",
					code: "// a long explanatory comment",
					path: "src/keep.ts",
					line: 3,
					file: "keep.ts",
				},
			],
			layerViolations: [],
			deadFunctions: [],
			issues: [],
			suggestions: [],
			patterns: [],
			fnStats: {},
			folders: [],
			duplicates: [],
			connections: [],
			stats: {
				files: 1,
				functions: 1,
				connections: 0,
				dead: 0,
				patterns: 0,
				security: 0,
				duplicates: 0,
				violations: 0,
				skipped: 0,
				loc: 10,
				languages: [],
			},
			files: [{ path: "keep.ts", content: null, piFpSource: null, functions: [] }],
		};
		const raw = calcHealth(clean);
		const data = await filtered(clean).then((r) => r.data);
		const dashboard = dashboardScore(data);
		const report = exportedReport(data);
		assert.equal(dashboard.score, raw.score, "no false positive: no drift from the seam");
		assert.equal(dashboard.score, report.json.summary.healthScore);
		assert.equal(report.json.summary.securityIssues, 1, "the survivor is still reported");
	});

	it("hands the dashboard exactly the stats the headless runner emits", async () => {
		const filter = requireCjs(FILTER);
		const shared = recordedPageData();
		const headless = filter.sanitizeAnalysisData(shared, filter.readFileFrom(shared)).data;

		const browserSide = recordedPageData();
		await filtered(browserSide);
		assert.equal(JSON.stringify(browserSide.stats), JSON.stringify(headless.stats));
		assert.equal(
			JSON.stringify(browserSide.securityIssues),
			JSON.stringify(headless.securityIssues),
		);
		assert.equal(
			JSON.stringify(browserSide.layerViolations),
			JSON.stringify(headless.layerViolations),
		);
	});
});

describe("dashboard score parity #2147 — served page end to end", () => {
	it("renders the filtered score and exports the same one, one run", async (t) => {
		const blocks = seamBlocks();
		const seam = rewrittenSeam(blocks["run-analysis-data"]);
		if (seam === null) return t.skip("python3 is unavailable to emit the served seam");

		const { sandbox, logs, captured } = pageSandbox(recordedPageData());
		vm.runInContext(seam, sandbox, { filename: "served-seam.js" });
		// The recorded analysis-completion call site: `await runAnalysisData({...})`
		// (the recorded block shows the shape; the arguments only feed the stubbed
		// analyzer, which returns the recorded snapshot).
		const resolved = await vm.runInContext(
			"globalThis.__run = runAnalysisData({ analyzed: [], allFns: [], excludePatterns: [], progress: function () {}, yieldFn: function () { return Promise.resolve(); } });",
			sandbox,
		);
		const data = resolved as Record<string, any>;
		assert.ok(data && typeof data === "object", "the seam must resolve the analysis data");

		// The page renders the score from the same object the seam filtered.
		sandbox.data = data;
		vm.runInContext(blocks["dashboard-score"], sandbox, { filename: "dashboard-score.js" });
		vm.runInContext(blocks["generate-report"], sandbox, { filename: "generate-report.js" });
		sandbox.generateReport("json");
		sandbox.generateReport("md");

		const health = sandbox.health;
		const json = JSON.parse(captured.get("codeflow-report.json") ?? "null");
		const md = captured.get("codeflow-report.md") ?? "";

		assert.ok(health.score >= 90, `the dashboard must show an A, got ${health.score}`);
		assert.equal(health.grade, "A");
		assert.equal(health.score, json.summary.healthScore, "one object, one score");
		assert.equal(health.grade, json.summary.healthGrade);
		assert.ok(md.includes(`| Health Score | ${health.score}/100 (${health.grade}) |`));
		assert.equal(
			data.securityIssues.filter((s: { severity: string }) => s.severity === "high").length,
			0,
			"the rendered snapshot carries no HIGH finding",
		);
		// The retained source is released once the filter has read it.
		assert.ok(
			data.files.every((f: { piFpSource: unknown }) => f.piFpSource === null),
			"a large scan must not pin its sources in the tab",
		);
		// One analysis, one suppression line — the seam is the only filter site.
		assert.equal(
			logs.filter((l) => l.startsWith("fp-filter: suppressed ")).length,
			1,
			logs.join("\n"),
		);
		assert.equal(
			logs.filter((l) => l.includes("derivation unavailable")).length,
			0,
			"the page's deriver is present, so no card is dropped and no second pass runs",
		);
		assert.equal(data.suggestions.length, 1, "the cards are re-derived from the filtered data");
	});

	it("fails the fixture generator when an upstream anchor moves (drift guard)", () => {
		// A moved seam must fail loudly. The generator is the guard: point it at a
		// page without the recorded anchors and it must exit non-zero instead of
		// writing a fixture the rewrite can no longer match.
		const dir = mkdtempSync(resolve(tmpdir(), "codeflow-seam-drift-"));
		cleanups.push(dir);
		writeFileSync(resolve(dir, "index.html"), "<html><body>no seam here</body></html>");
		let status = 0;
		let stderr = "";
		try {
			execFileSync(process.execPath, [GENERATOR], {
				env: { ...process.env, CODEFLOW_UI: resolve(dir, "index.html") },
				encoding: "utf-8",
				stdio: "pipe",
			});
		} catch (error) {
			const failure = error as { status?: number; stderr?: string };
			status = failure.status ?? -1;
			stderr = failure.stderr ?? "";
		}
		assert.notEqual(status, 0, "a page without the seam anchors must not record a fixture");
		assert.match(stderr, /anchor not found/, `the miss must be explained, got: ${stderr}`);
	});
});

describe("dashboard score parity #2147 — headless runner stays the same path", () => {
	it("filters once, before the report, and never at export time", () => {
		const runner = readFileSync(RUNNER, "utf-8");
		assert.equal(
			runner.split("sanitizeAnalysisData(").length - 1,
			1,
			"the producer must call the policy exactly once",
		);
		assert.match(
			runner,
			/const \{ markdown, json \} = captureExports\(reportSrc, helpers, filtered,/,
		);
		// Byte-parity of the suppression line is what keeps the two paths' logs equal;
		// the glue's copy is asserted in codeflow-fp-browser-glue-2147.test.mts.
		assert.match(
			runner,
			/`fp-filter: suppressed \$\{suppressed\.security\.length\} security issue\(s\), ` \+\n/,
		);
		assert.match(runner, /\$\{suppressed\.deadCode\.length\} unused function\(s\), ` \+/);
	});

	it("produces the same filtered snapshot on both adapters for one input", async () => {
		const filter = requireCjs(FILTER);
		const headless = recordedPageData();
		const headlessResult = filter.sanitizeAnalysisData(
			headless,
			filter.readFileFrom(headless),
		).data;
		const browserSide = recordedPageData();
		await filtered(browserSide);
		for (const key of [
			"securityIssues",
			"layerViolations",
			"deadFunctions",
			"duplicates",
			"issues",
			"stats",
		]) {
			assert.equal(
				JSON.stringify(browserSide[key]),
				JSON.stringify(headlessResult[key]),
				`${key} drifted between the served page and the headless runner`,
			);
		}
	});
});
