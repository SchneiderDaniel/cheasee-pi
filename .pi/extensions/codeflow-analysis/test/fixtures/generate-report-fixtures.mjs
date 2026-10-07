/**
 * Regenerate the CodeFlow report fixtures from the real vendored generator.
 *
 * The fixtures (`codeflow-report.md`, `codeflow-report.json`) are checked in so
 * the test suite needs neither Node-only CodeFlow nor a browser. This script is
 * the provenance proof: it runs the *actual* report code shipped in CodeFlow's
 * `index.html` (the md branch of `generateReport` and the `report` object that
 * backs the JSON export) against a representative analysis object, so the
 * fixtures are byte-for-byte what the browser export produces.
 *
 * Usage:
 *   CODEFLOW_UI=/path/to/codeflow/index.html node generate-report-fixtures.mjs
 *
 * Source captured from https://github.com/braedonsaunders/codeflow at
 * commit b0e82d127fc4990f571ebc6da6c5d9af2591aaa1 — the revision pinned by
 * `ARG CODEFLOW_REF` in the Dockerfile. Re-run this script from that checkout
 * when the pin moves; bridge.test.mts asserts the pin matches the captured
 * fixture revision.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const uiPath = process.env.CODEFLOW_UI;
if (!uiPath) {
	console.error("Set CODEFLOW_UI=/path/to/codeflow/index.html");
	process.exit(2);
}
const html = readFileSync(uiPath, "utf8");

function slice(startMarker, endMarker) {
	const s = html.indexOf(startMarker);
	const e = html.indexOf(endMarker, s + startMarker.length);
	if (s < 0 || e < 0 || e <= s) throw new Error(`markers not found: ${startMarker}`);
	return { body: html.slice(s + startMarker.length, e) };
}

// --- the report object shared by every format (JSON export) -----------------
const reportSrc = html.slice(html.indexOf("var report={"), html.indexOf("if(format==='json'){"));
const calcHealthSrc = html.slice(html.indexOf("function calcHealth(data){"), html.indexOf("// ===== CODEFLOW_METRICS_END ====="));
const calcHealth = new Function(calcHealthSrc + "\nreturn calcHealth;")();
// --- the markdown builder (format === 'md') ---------------------------------
const mdSrc = slice("}else if(format==='md'){", "}else if(format==='txt'){").body;
const buildMd = new Function("data", "repo", "h", "Blob", "URL", "document", mdSrc + "\nreturn md;");

// A representative analysis exercising every generator branch that carries
// file references: security, unused functions, patterns, anti-patterns and
// architecture issues (including a layer-violation issue), plus duplicates,
// layer violations and suggestions (JSON-only categories).
const data = {
	stats: {
		files: 9,
		functions: 14,
		loc: 1234,
		connections: 9,
		dead: 3,
		duplicates: 1,
		violations: 1,
		security: 1,
		languages: [{ name: "TypeScript", count: 9 }],
	},
	securityIssues: [
		{
			severity: "high",
			title: "Hardcoded secret",
			path: "src/config.ts",
			line: 12,
			desc: "Possible hardcoded API key.",
			code: 'const KEY = "sk-live-abc"',
		},
	],
	deadFunctions: [
		{ name: "legacyParse", file: "src/parser/legacy.ts", line: 44, codeLines: 18, code: "function legacyParse(){}", ext: ".ts" },
		{ name: "oldHelper", file: "src/util/helpers.ts", line: 3, codeLines: 5, code: "", ext: ".ts" },
		{ name: "deadBranch", file: "src/parser/legacy.ts", line: 90, codeLines: 7, code: "", ext: ".ts" },
	],
	patterns: [
		{ name: "Singleton", desc: "A single shared instance.", isAnti: false, severity: "info", files: [{ name: "src/registry.ts", path: "src/registry.ts" }], metrics: {} },
		{ name: "God Object", desc: "Files with too many responsibilities.", isAnti: true, severity: "warning", files: [{ name: "src/god.ts", path: "src/god.ts" }], metrics: {} },
	],
	issues: [
		{ type: "warning", title: "High coupling in parser layer", desc: "Parser files depend on UI modules.", items: [{ file: "src/parser/ast.ts" }, { file: "src/ui/render.ts" }] },
		{ type: "critical", title: "1 Architecture Violations", desc: "Lower layers importing from higher layers", items: [{ name: "domain → ui", file: "src/domain/b.ts", toFile: "src/ui/c.ts", fn: "render" }] },
		{ type: "warning", title: "Circular dependency", desc: "A cycle between two modules.", items: [{ file: "src/cycle/a.ts" }, { file: "src/cycle/b.ts" }] },
	],
	files: [
		{ path: "src/parser/ast.ts", name: "ast.ts", folder: "src/parser", layer: "Parser", lines: 220, churn: 1, isCode: true, functions: [{ name: "parse", line: 5, key: "parse" }] },
	],
	fnStats: {
		parse: { name: "parse", file: "src/parser/ast.ts", folder: "src/parser", line: 5, internal: 1, external: 2, isExported: true, isClassMethod: false, isTopLevel: true, type: "function", callers: [{ file: "src/a.ts", name: "main", count: 1 }] },
	},
	connections: [{ source: "src/parser/ast.ts", target: "src/ui/render.ts", fn: "render", count: 2 }],
	duplicates: [
		{ type: "name", name: "parseConfig", count: 3, files: [{ file: "src/dup/a.ts", line: 1 }, { file: "src/dup/b.ts", line: 2 }, { file: "src/dup/c.ts", line: 3 }], similarity: 80, suggestion: "consolidate" },
	],
	layerViolations: [{ from: "src/layer/from.ts", to: "src/layer/to.ts", fromLayer: "domain", toLayer: "ui", fn: "render", suggestion: "invert" }],
	suggestions: [
		{ priority: "high", icon: "layers", title: "Fix Architecture Violations", desc: "1 layer violations found.", action: "Invert dependencies", impact: "Improves testability" },
	],
	folders: [{ name: "src", files: 9 }],
};

const repo = "SchneiderDaniel/cheasee-pi";
const health = calcHealth(data);
const report = new Function("data", "repo", "h", "Parser", "getAnalysisSourceLabel", "calcHealth", reportSrc + "\nreturn report;")(
	data,
	repo,
	health,
	{ functionKey: (fn) => fn.name },
	() => repo,
	calcHealth,
);

const md = buildMd(data, repo, health, function () {}, { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} }, { createElement: () => ({ click: () => {} }) });

const here = dirname(new URL(import.meta.url).pathname);
writeFileSync(join(here, "codeflow-report.md"), md);
writeFileSync(join(here, "codeflow-report.json"), JSON.stringify(report, null, 2));
console.log(`wrote fixtures from ${uiPath} (CodeFlow b0e82d1)`);
