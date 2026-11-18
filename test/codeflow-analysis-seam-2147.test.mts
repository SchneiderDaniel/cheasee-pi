// ─── Dashboard/report score alignment, the analysis seam (#2147) ────
// The served page filtered its analysis inside `generateReport()`, i.e. after the
// dashboard had already scored the raw analyzer output — 72/C on screen against
// 94/A in the headless report for the same tree. The filter now runs once, at
// analysis completion: `ui_rewrites.py` wraps the page's own `runAnalysisData` and
// hands the result to `fp-filter/browser-glue.js`.
//
// This file pins the seam itself, driven through `python3` against the real
// `ui_rewrites.py` (the served bytes, never a JS re-implementation):
//
//   * the glue call is spliced into the analysis completion, before the page
//     scores the data, and `generateReport` is left a pure reader;
//   * the anchor matches the recorded pinned upstream bytes exactly once, and a
//     moved seam fails the fixture generator instead of silently scoring raw data;
//   * the whole rewrite set stays idempotent, and the module/serve wiring carries
//     the glue as the last module tag without reordering the policy modules.
//
// The behaviour of the glue itself is pinned in
// test/codeflow-fp-browser-glue-2147.test.mts; the dashboard/report parity in
// test/codeflow-dashboard-score-parity-2147.test.mts.
//
// Run: node --experimental-strip-types --test test/codeflow-analysis-seam-2147.test.mts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CODEFLOW = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow");
const FILTER = resolve(CODEFLOW, "fp-filter.js");
const UI_REWRITES_PY = resolve(CODEFLOW, "ui_rewrites.py");
const SEAM_FIXTURE = resolve(HERE, "fixtures/codeflow-dashboard-seam.html");

const PINNED_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

/** Run a python snippet against the served shim module. */
function python(snippet: string[], module = UI_REWRITES_PY): string | null {
	try {
		return execFileSync("python3", ["-c", snippet.join("\n"), module], { encoding: "utf-8" });
	} catch {
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

describe("dashboard score alignment #2147 — the analysis seam", () => {
	it("records the pinned upstream seam and its score expression", () => {
		const header = readFileSync(SEAM_FIXTURE, "utf-8").slice(0, 800);
		assert.match(
			header,
			new RegExp(`CodeFlow revision:\\s*${PINNED_REF}`),
			"the seam recording must name the pin the Dockerfile serves",
		);
		const dockerfile = readFileSync(resolve(CODEFLOW, "Dockerfile"), "utf-8");
		assert.match(
			dockerfile,
			new RegExp(`ARG CODEFLOW_REF=${PINNED_REF}`),
			"the fixture and the served revision must not drift",
		);
		assert.match(BLOCKS["run-analysis-data"] ?? "", /^function runAnalysisData\(options\)\{/, "the analysis seam must be recorded verbatim");
		assert.match(
			BLOCKS["dashboard-score"] ?? "",
			/calcHealth\(data\)/,
			"the dashboard score expression must be recorded verbatim",
		);
		assert.match(BLOCKS["generate-report"] ?? "", /^function generateReport\(format\)\{/);
		assert.match(BLOCKS["analysis-completion"] ?? "", /setData\(dataObj\);/);
	});

	it("splices one glue call into the seam, before the page scores the data", (t) => {
		const applied = pythonPiped(APPLY_ALL, readFileSync(SEAM_FIXTURE, "utf-8"));
		if (applied === null) return t.skip(PY_SKIP);
		assert.equal(
			applied.split("applyFalsePositiveFilter(").length - 1,
			1,
			"one application step at analysis completion",
		);
		const glueAt = applied.indexOf("piFpFilterBrowserGlue.applyFalsePositiveFilter(");
		const scoreAt = applied.indexOf("calcHealth(data)", glueAt);
		assert.ok(glueAt >= 0, "the seam must call the glue");
		assert.ok(scoreAt > glueAt, "the filter must run before the page scores the data");
		// The seam is the analysis completion, not the export: the injected call sits
		// in the recorded `runAnalysisData` block.
		assert.ok(glueAt < applied.indexOf(";@@END:run-analysis-data@@"));
	});

	it("leaves no filter in `generateReport` (the export only reads)", (t) => {
		const rewritten = pythonPiped(APPLY_ALL, readFileSync(SEAM_FIXTURE, "utf-8"));
		if (rewritten === null) return t.skip(PY_SKIP);
		const reportAt = rewritten.indexOf(";@@RECORDED:generate-report@@");
		assert.ok(reportAt > 0, "the recorded export must survive the rewrite set");
		const reportBody = rewritten.slice(reportAt);
		assert.equal(
			reportBody.includes("sanitizeAnalysisData"),
			false,
			"the export must not filter: the data it reads is already filtered",
		);
		assert.equal(reportBody.includes("piFpSource = null"), false);
		assert.equal(reportBody.includes("data.securityIssues ="), false);
		for (const stale of ["__piFpGenerateReport", "__piFp.data", "__piFpDead", "__piFpSugg", "__piFpDup"]) {
			assert.equal(
				rewritten.includes(stale),
				false,
				`the old in-page wrapper symbol ${stale} must be gone from the served page`,
			);
		}
	});

	it("matches the recorded seam anchor exactly once", (t) => {
		const count = pythonPiped(
			[
				"import runpy, sys",
				"m = runpy.run_path(sys.argv[1])",
				"pat, _repl = m['_UI_REWRITES'][0]",
				"print(len(pat.findall(sys.stdin.buffer.read())))",
			],
			readFileSync(SEAM_FIXTURE, "utf-8"),
		);
		if (count === null) return t.skip(PY_SKIP);
		assert.equal(
			count.trim(),
			"1",
			"the seam anchor must match the recorded page exactly once (zero = silent no-op)",
		);
	});

	it("applies the whole rewrite set idempotently to the recorded seam", (t) => {
		const out = pythonPiped(
			[
				"import runpy, sys",
				"m = runpy.run_path(sys.argv[1])",
				"src = sys.stdin.buffer.read()",
				"def apply(s):",
				"    for pat, repl in m['_UI_REWRITES']:",
				"        s = pat.sub(lambda _: repl, s)",
				"    return s",
				"once = apply(src)",
				"twice = apply(once)",
				"sys.stdout.write('SAME' if once == twice else 'DIFFERENT')",
			],
			readFileSync(SEAM_FIXTURE, "utf-8"),
		);
		if (out === null) return t.skip(PY_SKIP);
		assert.equal(out.trim(), "SAME");
	});

	it("serves the glue as the last module tag and keeps one index tag", (t) => {
		const out = python([
			"import runpy, sys",
			"m = runpy.run_path(sys.argv[1])",
			"print(','.join(m['_FP_FILTER_MODULES']))",
			"print(m['_BRIDGE_SCRIPT'].decode())",
		]);
		if (out === null) return t.skip(PY_SKIP);
		const [modules, bridge] = out.trimEnd().split("\n");
		const names = modules.split(",");
		assert.equal(names[names.length - 1], "browser-glue", "the glue is the last module tag");
		assert.ok(names.includes("browser-glue"));
		const tags = [...bridge.matchAll(/<script src="fp-filter\/([\w/-]+)\.js" defer><\/script>/g)].map((m) => m[1]);
		assert.deepEqual(tags, names, "one tag per allowlisted module, in load order");
		const indexTag = '<script src="fp-filter.js" defer></script>';
		assert.equal(bridge.split(indexTag).length - 1, 1, "exactly one index tag");
		const indexAt = bridge.indexOf(indexTag);
		assert.ok(bridge.indexOf('src="fp-filter/browser-glue.js"') < indexAt, "the glue must load before the index");
		assert.ok(bridge.indexOf('src="codeflow-bridge.js"') > indexAt, "the bridge follows the index");
		assert.equal(bridge.split('src="fp-filter.js"').length - 1, 1, "the index is referenced once");
	});

	it("serves /fp-filter/browser-glue.js from the allowlist and still confines", (t) => {
		const out = python([
			"import runpy, sys",
			"m = runpy.run_path(sys.argv[1])",
			"out = []",
			"name = m['_fp_filter_module_name']('browser-glue.js')",
			"out.append(name or 'MISS')",
			"out.append('read' if b'piFpFilterBrowserGlue' in m['_fp_filter_module_bytes']('browser-glue') else 'empty')",
			"globals_ = m['_fp_filter_module_bytes'].__globals__",
			"globals_['_FP_FILTER_MODULE_PATHS']['browser-glue'] = '../server'",
			"try:",
			"    m['_fp_filter_module_bytes']('browser-glue')",
			"except OSError as exc:",
			"    out.append('confined' if 'escapes' in str(exc) else 'OSError')",
			"else:",
			"    out.append('escaped')",
			"print(','.join(out))",
		]);
		if (out === null) return t.skip(PY_SKIP);
		assert.equal(out.trim(), "browser-glue,read,confined");
	});

	it("keeps the glue out of the policy-module wiring (`fp-filter.js` is unchanged)", () => {
		// The glue is the application step, not a policy module: the policy index
		// must not load it, or the headless runner would filter twice.
		const index = readFileSync(FILTER, "utf-8");
		assert.equal(index.includes("browser-glue"), false, "the policy index does not load the glue");
		assert.equal(index.includes("applyFalsePositiveFilter"), false, "no application step in the policy");
	});
});
