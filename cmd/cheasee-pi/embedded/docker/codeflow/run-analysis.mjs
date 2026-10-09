#!/usr/bin/env node
// Headless CodeFlow report producer.
//
// The browser UI builds its exports client-side; this runner drives the same
// code without a browser so the shim's report slots can be filled on demand.
// It reuses the pinned UI checkout's own analyzer and report source, so the
// markdown/JSON artifacts cannot drift from what the UI exports:
//   1. slice the CODEFLOW_ANALYZER + CODEFLOW_METRICS blocks out of index.html
//      and run them in a Node vm (exactly like card/lib/analyzer.js), and
//   2. extract the `generateReport` function from index.html and call it with
//      stub Blob/URL/document objects, capturing the bytes it hands to
//      URL.createObjectURL — the same seam the browser bridge hooks.
//
// Usage: run-analysis.mjs <sourceDir> <uiDir> <outDir>
//   sourceDir  committed HEAD snapshot (the shim runs `git archive HEAD` first)
//   uiDir      pinned CodeFlow checkout (contains index.html + card/lib/*.js)
//   outDir     destination for report.md / report.json
//
// Exit 0 and print a final-line envelope {markdown,json,analyzedAt,stats,terms}
// on success; nonzero with a bounded stderr message on failure. Only node:
// builtins.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ANALYZER_START = "// ===== CODEFLOW_ANALYZER_START =====";
const ANALYZER_END = "// ===== CODEFLOW_ANALYZER_END =====";
const METRICS_START = "// ===== CODEFLOW_METRICS_START =====";
const METRICS_END = "// ===== CODEFLOW_METRICS_END =====";

function fail(message) {
	process.stderr.write(String(message).slice(0, 4096) + "\n");
	process.exit(1);
}

// The two live calcHealth terms, derived from the analyzer's own stats so the
// score inputs are reproducible without the browser UI: coupling is
// min(15, max(0, connections/files - 3) * 2), dead code min(20, dead/functions
// * 100). Read-only measurement — report production is never gated on it, so
// unusable stats yield `terms: null` instead of failing the run.
function scoreTerms(stats) {
	if (!stats || typeof stats !== "object") return null;
	const { files, connections, functions, dead } = stats;
	const usable = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	if (![files, connections, functions, dead].every(usable)) return null;
	if (files === 0 || functions === 0) return null;
	const round3 = (n) => Math.round(n * 1000) / 1000;
	return {
		coupling: round3(Math.min(15, Math.max(0, connections / files - 3) * 2)),
		deadCode: round3(Math.min(20, (dead / functions) * 100)),
	};
}

function sliceBlock(html, start, end, label) {
	const from = html.indexOf(start);
	const to = html.indexOf(end, from);
	if (from < 0 || to < 0) {
		throw new Error(`index.html is missing the CODEFLOW_${label.toUpperCase()} block`);
	}
	return html.slice(from, to);
}

// Extract `function <name>(...) {...}` verbatim by balancing braces. Strings,
// template literals and comments are skipped so braces inside them do not
// count. shortcut: no regex-literal handling, generateReport has none.
function extractFunction(html, name) {
	const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
	if (!match) return null;
	const open = html.indexOf("{", match.index);
	if (open < 0) return null;
	const close = matchBrace(html, open);
	return close < 0 ? null : html.slice(match.index, close + 1);
}

function matchBrace(src, open) {
	let depth = 0;
	let i = open;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "'" || ch === '"' || ch === "`") {
			i = skipString(src, i, ch);
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			i = src.indexOf("\n", i);
			if (i < 0) return -1;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i = src.indexOf("*/", i + 2);
			if (i < 0) return -1;
			i += 2;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
		i++;
	}
	return -1;
}

function skipString(src, i, quote) {
	i++;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === quote) return i + 1;
		i++;
	}
	return i;
}

// Run the analyzer + metrics blocks in a vm and return the exported helpers,
// mirroring card/lib/analyzer.js so the UI's parser is the single source.
function loadHelpers(indexHtml) {
	const analyzerSrc = sliceBlock(indexHtml, ANALYZER_START, ANALYZER_END, "analyzer");
	const metricsSrc = sliceBlock(indexHtml, METRICS_START, METRICS_END, "metrics");
	const context = {
		console,
		TreeSitter: undefined,
		Babel: undefined,
		acorn: undefined,
		getSecurityScanContent(file) {
			return file && file.content ? file.content : "";
		},
		isSanitizedPreviewRenderer() {
			return false;
		},
	};
	vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
	const expose =
		"\nthis.Parser = Parser;" +
		"\nthis.buildAnalysisData = buildAnalysisData;" +
		"\nthis.calcHealth = calcHealth;";
	new vm.Script(analyzerSrc + "\n" + metricsSrc + expose, {
		filename: "codeflow-analyzer.js",
	}).runInContext(context, { timeout: 1000 });
	return context;
}

// Drive `generateReport('md'|'json')` in a sandbox and capture the bytes it
// hands to the URL.createObjectURL stub — the exact UI export seam.
function captureExports(reportSrc, helpers, data, labels) {
	const captures = new Map();
	let pending = null;
	let pendingType = "";
	const Blob = function (parts) {
		this.parts = Array.isArray(parts) ? parts : [parts];
		this.text = () => Promise.resolve(this.parts.map(String).join(""));
	};
	const context = {
		console,
		data,
		calcHealth: helpers.calcHealth,
		Parser: helpers.Parser,
		getAnalysisSourceLabel: () => labels.sourceLabel,
		repoInfo: labels.repoInfo,
		localSourceKind: labels.localSourceKind,
		Blob,
		URL: {
			createObjectURL(blob) {
				pending = (blob && blob.parts ? blob.parts : []).map(String).join("");
				pendingType = (blob && blob.type) || (blob && blob.parts && blob.type) || "";
				return "blob:codeflow-report";
			},
			revokeObjectURL() {},
		},
		document: {
			createElement() {
				return {
					href: "",
					download: "",
					click() {
						if (typeof this.download === "string" && this.download) {
							captures.set(this.download, pending ?? "");
						}
					},
				};
			},
		},
		showNotification() {},
	};
	vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
	new vm.Script(reportSrc + "\nthis.generateReport = generateReport;", {
		filename: "codeflow-report.js",
	}).runInContext(context, { timeout: 1000 });
	if (typeof context.generateReport !== "function") {
		throw new Error("index.html exports no generateReport function");
	}
	context.generateReport("md");
	let json = null;
	try {
		context.generateReport("json");
		json = captures.get("codeflow-report.json") ?? null;
	} catch {
		// The structured export is best-effort: markdown alone is still a report.
		json = null;
	}
	const markdown = captures.get("codeflow-report.md") ?? null;
	if (markdown === null) {
		throw new Error("the UI export emitted no Blob for the markdown report");
	}
	void pendingType;
	return { markdown, json };
}

async function main() {
	const [sourceDir, uiDir, outDir] = process.argv.slice(2);
	if (!sourceDir || !uiDir || !outDir) {
		fail("usage: run-analysis.mjs <sourceDir> <uiDir> <outDir>");
	}

	const indexHtmlPath = path.join(uiDir, "index.html");
	const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
	const helpers = loadHelpers(indexHtml);

	// Build `data` with the checkout's own headless pipeline (card/lib/analysis.js).
	const require = createRequire(import.meta.url);
	const analysis = require(path.join(uiDir, "card", "lib", "analysis.js"));
	const { data } = await analysis.analyze({
		repoRoot: sourceDir,
		indexHtmlPath,
		actionDir: path.join(uiDir, "card"),
	});

	const reportSrc = extractFunction(indexHtml, "generateReport");
	if (!reportSrc) {
		throw new Error("index.html does not define generateReport");
	}
	const { markdown, json } = captureExports(reportSrc, helpers, data, {
		sourceLabel: "local/workspace",
		repoInfo: { name: "workspace" },
		localSourceKind: "folder",
	});

	if (!markdown) {
		throw new Error("the UI export produced an empty markdown report");
	}

	const markdownName = "report.md";
	const jsonName = json === null ? null : "report.json";
	fs.writeFileSync(path.join(outDir, markdownName), markdown, "utf8");
	if (json !== null) {
		fs.writeFileSync(path.join(outDir, jsonName), json, "utf8");
	}

	const stats = data && data.stats !== undefined ? data.stats : null;
	process.stdout.write(
		JSON.stringify({
			markdown: markdownName,
			json: jsonName,
			analyzedAt: Date.now(),
			stats,
			terms: scoreTerms(stats),
		}) + "\n",
	);
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
