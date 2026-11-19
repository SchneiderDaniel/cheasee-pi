// ─── Dashboard/report score alignment, glue + seam (issue #2147) ────
// The served dashboard scored the *raw* analyzer output while the report was
// built from filtered data (72/C on screen vs 94/A in the headless report), so
// the false-positive filter now runs once, at analysis completion, through a
// single application step (`fp-filter/browser-glue.js`) that the seam rewrite in
// `ui_rewrites.py` calls. This file pins that step and that seam:
//
//   * the glue — one policy call per application, in-place field write-back, the
//     retained-source release, byte-identical suppression logging, and the
//     fail-closed error path (never a partial write, never a silent no-op);
//   * the seam — the injected call precedes the page's `calcHealth(data)`, the
//     `generateReport` wrapper is gone, the anchor matches the recorded pinned
//     upstream bytes exactly once, and the whole rewrite set stays idempotent.
//
// Run: node --experimental-strip-types --test test/codeflow-fp-browser-glue-2147.test.mts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CODEFLOW = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow");
const GLUE = resolve(CODEFLOW, "fp-filter/browser-glue.js");
const FILTER = resolve(CODEFLOW, "fp-filter.js");
const MODULE_DIR = resolve(CODEFLOW, "fp-filter");
const UI_REWRITES_PY = resolve(CODEFLOW, "ui_rewrites.py");
const SEAM_FIXTURE = resolve(HERE, "fixtures/codeflow-dashboard-seam.html");
const FIXTURE = resolve(HERE, "fixtures/codeflow-real-analysis-fp.json");

const PINNED_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

const requireCjs = createRequire(import.meta.url);

/** python3 is the only verifier of the served Python; null when it is absent. */
function python(script: string[], module = UI_REWRITES_PY): string | null {
	try {
		return execFileSync("python3", ["-c", script.join("\n"), module], { encoding: "utf-8" });
	} catch (error) {
		return null;
	}
}

const PY_SKIP = "python3 is unavailable to emit the served rewrite";

/** Run a python snippet with `input` on stdin against the served shim module. */
function pythonPiped(snippet: string[], input: string, module = UI_REWRITES_PY): string | null {
	try {
		return execFileSync("python3", ["-c", snippet.join("\n"), module], {
			input,
			encoding: "utf-8",
			maxBuffer: 1 << 26,
		});
	} catch {
		return null;
	}
}

/** The full `_UI_REWRITES` tuple applied, in order, to `input`. */
const APPLY_ALL = [
	"import runpy, sys",
	"m = runpy.run_path(sys.argv[1])",
	"src = sys.stdin.buffer.read()",
	"for pat, repl in m['_UI_REWRITES']:",
	"    src = pat.sub(lambda _: repl, src)",
	"sys.stdout.buffer.write(src)",
];

/** The recorded seam blocks, keyed by id, straight out of the pinned fixture. */
function seamBlocks(): Record<string, string> {
	const text = readFileSync(SEAM_FIXTURE, "utf-8");
	const blocks: Record<string, string> = {};
	const re = /^;@@RECORDED:([\w-]+)@@\n([\s\S]*?)\n;@@END:\1@@$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) blocks[m[1]] = m[2];
	return blocks;
}

const BLOCKS = seamBlocks();

/** The false-positive filter the served page publishes as `piFpFilter`. */
function browserFilter(): Record<string, any> {
	const sandbox: Record<string, any> = {};
	vm.createContext(sandbox);
	for (const name of readdirSync(MODULE_DIR, { recursive: true }) as string[]) {
		if (name === "browser-glue.js" || !name.endsWith(".js")) continue;
		vm.runInContext(readFileSync(resolve(MODULE_DIR, name), "utf-8"), sandbox, {
			filename: `${name}.js`,
		});
	}
	vm.runInContext(readFileSync(FILTER, "utf-8"), sandbox, { filename: "fp-filter.js" });
	return sandbox;
}

/** The served glue, loaded the way the page's script tag loads it. */
function browserGlue(sandbox: Record<string, any>): Record<string, any> {
	vm.runInContext(readFileSync(GLUE, "utf-8"), sandbox, { filename: "browser-glue.js" });
	assert.equal(
		typeof sandbox.piFpFilterBrowserGlue?.applyFalsePositiveFilter,
		"function",
		"the glue tag must publish piFpFilterBrowserGlue.applyFalsePositiveFilter",
	);
	return sandbox.piFpFilterBrowserGlue;
}

/** The Node build of the glue (the same file, the CJS branch of its UMD). */
function nodeGlue(): {
	applyFalsePositiveFilter: (data: any, opts?: Record<string, any>) => any;
} {
	return requireCjs(GLUE);
}

const HIGH = (i: number) => ({
	severity: "high",
	title: "Hardcoded Secret",
	desc: "A literal credential",
	code: "",
	path: `src/mod${i}.ts`,
	line: i + 1,
	file: `mod${i}.ts`,
});

/** An analyzer result carrying the false positives the score must not see. */
function analysis(): Record<string, any> {
	return {
		securityIssues: [
			...Array.from({ length: 9 }, (_, i) => HIGH(i)),
			{
				severity: "medium",
				title: "Command Execution",
				desc: "whole-file node:child_process import",
				code: "await spawn(cmd)",
				path: "src/exec.ts",
				line: 7,
				file: "exec.ts",
			},
			{
				severity: "low",
				title: "Code Comments",
				desc: "deferred-work token in a test fixture",
				code: "// FIXME: nope",
				path: "src/widget.test.ts",
				line: 3,
				file: "widget.test.ts",
			},
		],
		layerViolations: [
			{ from: "src/a.ts", to: "src/b.ts", fromLayer: "ui", toLayer: "db", fn: "save" },
			{ from: "src/c.ts", to: "src/d.ts", fromLayer: "db", toLayer: "ui", fn: "load" },
		],
		deadFunctions: [
			{
				name: "deadCall",
				file: "def.ts",
				folder: "root",
				line: 1,
				code: "",
				codeLines: 0,
				ext: "ts",
			},
		],
		issues: [
			{
				type: "warning",
				title: "1 Unused Functions",
				desc: "Functions not called from other files",
				items: [{ name: "deadCall", file: "def.ts" }],
			},
			{
				type: "critical",
				title: "2 Architecture Violations",
				desc: "Lower layers importing from higher layers",
				items: [{ name: "ui → db", file: "src/a.ts" }],
			},
			{
				type: "warning",
				title: "9 High Complexity Files",
				desc: "Approximate cyclomatic complexity",
				items: [{ name: "mod0.ts (44)", file: "src/mod0.ts" }],
			},
		],
		suggestions: [
			{ title: "Fix Security Issues", desc: "9 high-severity issues found." },
			{ title: "Fix Architecture Violations", desc: "2 layer violations found." },
		],
		stats: {
			files: 2,
			functions: 10,
			connections: 1,
			dead: 1,
			patterns: 0,
			security: 9,
			duplicates: 0,
			violations: 2,
			skipped: 0,
			loc: 120,
			languages: [{ ext: "ts", lines: 120, pct: 100 }],
			parserModes: [{ mode: "heuristic-regex", files: 2 }],
		},
		files: [
			{ path: "def.ts", content: null, piFpSource: "export function deadCall() {}" },
			{ path: "use.ts", content: null, piFpSource: "function run() { deadCall(); }" },
		],
	};
}

const highs = (list: Array<{ severity: string }>) =>
	list.filter((s) => String(s.severity).toLowerCase() === "high");

describe("dashboard score alignment #2147 — browser glue", () => {
	it("filters in place: the dashboard sees the same arrays the report does", () => {
		const data = analysis();
		const { applyFalsePositiveFilter } = nodeGlue();
		const returned = applyFalsePositiveFilter(data, { console: { info() {} } });

		assert.equal(returned, data, "the same object is the one filtered (no new snapshot)");
		assert.deepEqual(highs(data.securityIssues), [], "no HIGH finding may survive");
		assert.equal(
			data.securityIssues.length,
			1,
			"the MEDIUM hit whose file the glue cannot read stays (fail open per finding)",
		);
		assert.equal(data.securityIssues[0].title, "Command Execution");
		assert.deepEqual(data.layerViolations, [], "the whole layer category is noise here");
		assert.deepEqual(data.deadFunctions, [], "the referenced dead function is dropped");
		assert.deepEqual(data.suggestions, [], "no deriver: the stale cards go with the counts");
		assert.equal(data.stats.security, 0, "stats.security moves with the surviving list");
		assert.equal(data.stats.violations, 0, "stats.violations moves with the surviving list");
		assert.equal(data.stats.dead, 0, "stats.dead moves with the surviving list");
		assert.deepEqual(
			data.issues.map((i: { title: string }) => i.title),
			["9 High Complexity Files"],
			"the aggregate architecture entries leave with their items",
		);
	});

	it("calls the policy exactly once per application", () => {
		const filter = createRequire(import.meta.url)(FILTER);
		let calls = 0;
		const counting = {
			readFileFrom: filter.readFileFrom,
			sanitizeAnalysisData(...args: unknown[]) {
				calls++;
				return (filter.sanitizeAnalysisData as (...a: unknown[]) => unknown)(...args);
			},
		};
		const { applyFalsePositiveFilter } = nodeGlue();
		applyFalsePositiveFilter(analysis(), { piFpFilter: counting, console: { info() {} } });
		assert.equal(calls, 1, "the seam (not the export) filters: one pass, never two");
	});

	it("passes the page's own deriver through and replaces the cards with its verdict", () => {
		const data = analysis();
		const seen: number[] = [];
		const Parser = {
			generateSuggestions(filtered: any) {
				seen.push(filtered.securityIssues.length, filtered.layerViolations.length);
				return [{ title: "Remove Dead Code", desc: "0 unused functions detected." }];
			},
		};
		nodeGlue().applyFalsePositiveFilter(data, { Parser, console: { info() {} } });
		assert.deepEqual(
			seen,
			[1, 0],
			"the deriver must see the filtered arrays, not the analyzer's originals",
		);
		assert.deepEqual(data.suggestions, [
			{ title: "Remove Dead Code", desc: "0 unused functions detected." },
		]);
	});

	it("drops the cards and says so when no deriver is available", () => {
		const logs: string[] = [];
		nodeGlue().applyFalsePositiveFilter(analysis(), {
			console: { info: (m: string) => logs.push(String(m)) },
		});
		assert.ok(
			logs.includes("fp-filter: dropped 2 derived suggestion(s): derivation unavailable"),
			`the degradation must be visible, got: ${JSON.stringify(logs)}`,
		);
	});

	it("logs the headless suppression line byte-for-byte", () => {
		const logs: string[] = [];
		nodeGlue().applyFalsePositiveFilter(analysis(), {
			console: { info: (m: string) => logs.push(String(m)) },
		});
		assert.deepEqual(logs, [
			"fp-filter: suppressed 9 security issue(s), 2 layer violation(s), 1 hygiene finding(s), 1 unused function(s), 0 duplicate group(s)",
			"fp-filter: dropped 2 derived suggestion(s): derivation unavailable",
		]);
	});

	it("stays quiet when nothing is suppressed", () => {
		const logs: string[] = [];
		const clean = {
			securityIssues: [
				{ severity: "low", title: "Code Comments", code: "x", path: "src/keep.ts", desc: "" },
			],
			layerViolations: [],
			deadFunctions: [],
			issues: [],
			suggestions: [],
			stats: { dead: 0, security: 0, violations: 0, duplicates: 0 },
			files: [],
		};
		nodeGlue().applyFalsePositiveFilter(clean, {
			console: { info: (m: string) => logs.push(String(m)) },
		});
		assert.deepEqual(logs, [], "a clean analysis must not log a suppression line");
		assert.equal(clean.securityIssues.length, 1, "the survivor stays");
	});

	it("releases the retained source and leaves `content` alone", () => {
		const data = analysis();
		nodeGlue().applyFalsePositiveFilter(data, { console: { info() {} } });
		assert.ok(
			data.files.every((f: { piFpSource: unknown }) => f.piFpSource === null),
			"a large scan must not pin its sources in the tab after the analysis",
		);
		assert.ok(
			data.files.every((f: { content: unknown }) => f.content === null),
			"the analyzer's own freed `content` is not resurrected",
		);
	});

	it("leaves absent keys absent and never materialises `undefined`", () => {
		const minimal: Record<string, any> = {};
		const returned = nodeGlue().applyFalsePositiveFilter(minimal, { console: { info() {} } });
		assert.equal(returned, minimal);
		for (const key of [
			"securityIssues",
			"layerViolations",
			"duplicates",
			"suggestions",
			"stats",
			"files",
		]) {
			assert.equal(key in minimal, false, `${key} must not appear out of thin air`);
		}
		assert.deepEqual(Object.keys(minimal), [], "the object stays empty");
	});

	it("reconciles an emptied analysis to zero, never a negative count", () => {
		const data = analysis();
		data.deadFunctions = [];
		data.stats.dead = 0;
		nodeGlue().applyFalsePositiveFilter(data, { console: { info() {} } });
		assert.equal(data.stats.dead, 0);
		assert.ok(data.stats.dead >= 0 && data.stats.security >= 0 && data.stats.violations >= 0);
	});

	it("is idempotent: a second application resurrects nothing", () => {
		const glue = nodeGlue();
		const once = analysis();
		glue.applyFalsePositiveFilter(once, { console: { info() {} } });
		const snapshot = JSON.stringify(once);

		const twice = analysis();
		glue.applyFalsePositiveFilter(twice, { console: { info() {} } });
		glue.applyFalsePositiveFilter(twice, { console: { info() {} } });
		assert.equal(JSON.stringify(twice), snapshot, "double application must be a no-op");
	});

	it("keeps no state across two analyses (one page, two runs)", () => {
		const glue = nodeGlue();
		const first = analysis();
		glue.applyFalsePositiveFilter(first, { console: { info() {} } });
		const second = analysis();
		glue.applyFalsePositiveFilter(second, { console: { info() {} } });
		assert.equal(
			JSON.stringify(second),
			JSON.stringify(first),
			"the second analysis must classify exactly like the first",
		);
	});

	it("fails closed on a sanitizer throw: banner, rethrow, no partial write", () => {
		const data = analysis();
		const before = JSON.stringify(data);
		const reported: string[] = [];
		const scope: Record<string, any> = {
			__codeflowBridgeReportError: (m: string) => reported.push(String(m)),
		};
		const failing = {
			readFileFrom: () => () => null,
			sanitizeAnalysisData() {
				throw new Error("boom");
			},
		};
		assert.throws(
			() =>
				nodeGlue().applyFalsePositiveFilter(data, {
					piFpFilter: failing,
					global: scope,
					console: { info() {} },
				}),
			/boom/,
			"a filter failure must abort the analysis, never fall through to raw data",
		);
		assert.deepEqual(reported, ["false-positive filter failed; report not exported: boom"]);
		assert.equal(scope.__codeflowFpFilterError, "boom", "the error stays inspectable");
		assert.equal(JSON.stringify(data), before, "no field may be half-written");
	});

	it("fails closed when the page's data cannot be written (frozen object)", () => {
		const reported: string[] = [];
		const scope: Record<string, any> = {
			__codeflowBridgeReportError: (m: string) => reported.push(String(m)),
		};
		const frozen = Object.freeze({ securityIssues: [HIGH(0)], layerViolations: [] });
		assert.throws(
			() =>
				nodeGlue().applyFalsePositiveFilter(frozen, {
					global: scope,
					console: { info() {} },
				}),
			TypeError,
			"a rejected write must throw instead of shipping data the filter never wrote",
		);
		assert.match(reported[0] ?? "", /false-positive filter failed; report not exported: /);
	});

	it("throws immediately when the policy is missing (never a silent no-op)", () => {
		const sandbox: Record<string, any> = { console: { info() {} } };
		vm.createContext(sandbox);
		const glue = browserGlue(sandbox);
		assert.throws(
			() => glue.applyFalsePositiveFilter(analysis()),
			/fp-filter/,
			"the page-side glue must not run without the policy it wraps",
		);
	});

	it("keeps findings it cannot disprove when the page retained no source", () => {
		const glue = nodeGlue();
		const data = analysis();
		// The analyzer frees the source; a page that never retained it reads null.
		for (const file of data.files) {
			file.piFpSource = null;
			file.content = null;
		}
		data.deadFunctions = [
			{
				name: "deadCall",
				file: "def.ts",
				folder: "root",
				line: 1,
				code: "",
				codeLines: 0,
				ext: "ts",
			},
		];
		glue.applyFalsePositiveFilter(data, { console: { info() {} } });
		assert.equal(
			data.securityIssues.filter((s: { title: string }) => s.title === "Command Execution").length,
			1,
			"an unreadable file is not evidence: the MEDIUM hit survives",
		);
	});

	it("publishes one browser global and keeps the headless load path intact", () => {
		const sandbox = browserFilter();
		const before = new Set(Object.keys(sandbox));
		browserGlue(sandbox);
		const published = Object.keys(sandbox).filter((key) => !before.has(key));
		assert.deepEqual(published, ["piFpFilterBrowserGlue"], "one new global, nothing else");
		assert.equal(typeof sandbox.piFpFilter.sanitizeAnalysisData, "function");
	});

	it("filters the recorded pinned-analyzer output through the browser path", () => {
		const sandbox = browserFilter();
		const glue = browserGlue(sandbox);
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf-8"));
		const highsBefore = highs(recorded.securityIssues).length;
		assert.ok(highsBefore >= 9, "the recording must carry the HIGH hits, or this is vacuous");

		// Only the cites the findings name need text: an unread path is simply
		// unreadable, and the filter keeps whatever it cannot disprove.
		const cited = new Set<string>([
			...recorded.securityIssues.map((s: { path?: string }) => String(s.path)),
			...recorded.deadFunctions.map((f: { file?: string }) => String(f.file)),
		]);
		const raw = (rel: string): string | null => {
			if (!cited.has(rel)) return null;
			try {
				return readFileSync(resolve(ROOT, rel), "utf-8");
			} catch {
				return null;
			}
		};
		const data = {
			...recorded,
			files: recorded.files.map((f: { path: string }) => ({
				path: f.path,
				content: null,
				piFpSource: raw(f.path),
			})),
		};
		glue.applyFalsePositiveFilter(data, { console: { info() {} } });
		assert.equal(highs(data.securityIssues).length, 0, "the browser path drops every HIGH hit");
		assert.equal(data.stats.security, 0);
		assert.equal(data.stats.violations, 0);
		assert.equal(data.stats.dead, data.deadFunctions.length);
	});

	it("ships the glue as a served module next to the policy it applies", () => {
		assert.ok(existsSync(GLUE), "fp-filter/browser-glue.js must exist");
		assert.match(
			readFileSync(GLUE, "utf-8"),
			/piFpFilterBrowserGlue/,
			"the served tag publishes piFpFilterBrowserGlue",
		);
	});
});
