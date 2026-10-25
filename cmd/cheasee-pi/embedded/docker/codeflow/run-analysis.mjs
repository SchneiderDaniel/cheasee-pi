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
// The analyzed `data` is passed through fp-filter.js first, which drops the
// analyzer's known false positives (see that file) so the health score, the
// markdown and the structured export all agree. The same filter prunes the
// coupling edges that are not dependencies, and the run reports that measurement
// in its envelope — but only when the analyzer's own architecture deriver is
// available to re-title the card that counts them.
//
// Usage: run-analysis.mjs <sourceDir> <uiDir> <outDir>
//   sourceDir  committed HEAD snapshot (the shim runs `git archive HEAD` first)
//   uiDir      pinned CodeFlow checkout (contains index.html + card/lib/*.js)
//   outDir     destination for report.md / report.json
//
// Exit 0 and print a final-line envelope {markdown,json,analyzedAt,stats,terms,
// coupling} on success; nonzero with a bounded stderr message on failure. Only
// node: builtins.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fpFilter = createRequire(import.meta.url)(path.join(HERE, "fp-filter.js"));

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
	const { files: fileCount, connections: linkCount, functions: fnCount, dead: deadCount } = stats;
	const usable = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	if (![fileCount, linkCount, fnCount, deadCount].every(usable)) return null;
	if (fileCount === 0 || fnCount === 0) return null;
	return {
		coupling: Math.round(Math.min(15, Math.max(0, linkCount / fileCount - 3) * 2) * 1000) / 1000,
		deadCode: Math.round(Math.min(20, (deadCount / fnCount) * 100) * 1000) / 1000,
	};
}

// Read one analyzed path out of the snapshot the analyzer ran against, so the
// false-positive rules can see the cited code. An unreadable path returns null:
// the filter keeps a finding it cannot disprove.
//
// Exported so a test can exercise this exact reader (the producer's only
// filesystem read) instead of re-implementing it.
export function makeReadFile(sourceDir) {
	let snapshotRoot;
	try {
		snapshotRoot = fs.realpathSync(path.resolve(sourceDir));
	} catch {
		return () => null;
	}
	// `mod x;` splices `x/`'s files into `x.rs`, so the split moved code the
	// analyzer attributes to the facade into children it never names. Collect the
	// children on disk and let fp-filter decide which ones are that module's.
	function moduleChildren(rel) {
		if (!rel.endsWith(".rs")) return [];
		const found = [];
		const stack = [[path.join(snapshotRoot, rel.slice(0, -3)), rel.slice(0, -3)]];
		while (stack.length) {
			const [absDir, prefix] = stack.pop();
			let entries;
			try {
				entries = fs.readdirSync(absDir, { withFileTypes: true });
			} catch (error) {
				// No `<stem>/` directory means no children. Any other failure means
				// the module cannot be resolved completely, so abort the read (the
				// caller turns that into `null` and the finding keeps standing).
				if (error && error.code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				const childRel = `${prefix}/${entry.name}`;
				if (entry.isDirectory()) stack.push([path.join(absDir, entry.name), childRel]);
				else found.push(childRel);
			}
		}
		return fpFilter.moduleChildPaths(rel, found);
	}
	return (rel) => {
		if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || rel.includes("..")) {
			return null;
		}
		try {
			const abs = path.resolve(snapshotRoot, rel);
			if (!abs.startsWith(snapshotRoot + path.sep)) return null;
			// A tracked symlink may point outside the snapshot: a lexical check
			// cannot see that, so resolve the real file and re-check containment.
			const real = fs.realpathSync(abs);
			if (!real.startsWith(snapshotRoot + path.sep)) return null;
			const parts = [fs.readFileSync(real, "utf8")];
			for (const child of moduleChildren(rel)) {
				const childReal = fs.realpathSync(path.resolve(snapshotRoot, child));
				if (!childReal.startsWith(snapshotRoot + path.sep)) return null;
				parts.push(fs.readFileSync(childReal, "utf8"));
			}
			return parts.join("\n");
		} catch {
			// A facade whose children cannot be read is incomplete, so the finding
			// must stand: fail open rather than return half a module.
			return null;
		}
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
			i++;
			while (i < src.length) {
				if (src[i] === "\\") {
					i += 2;
					continue;
				}
				if (src[i] === ch) {
					i++;
					break;
				}
				i++;
			}
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
	let pendingExport = null;
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
				pendingExport = (blob && blob.parts ? blob.parts : []).map(String).join("");
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
							captures.set(this.download, pendingExport ?? "");
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

	// A throw here aborts the run: an unsanitized report is never exported.
	// `data.suggestions` is derived from the arrays the filter shrinks, so the
	// filter re-derives it through the pinned analyzer's own function (a port —
	// the seven rules are never mirrored here).
	// The coupling card is a count over the connection list, so it is re-derived by
	// the pinned analyzer's own function after the prune (a port, exactly like
	// `generateSuggestions`). Without that port nothing is pruned at all.
	const architectureDeriver =
		helpers.Parser && typeof helpers.Parser.generateArchitectureIssues === "function"
			? (pruned) => helpers.Parser.generateArchitectureIssues(pruned)
			: null;
	const deriveSuggestions =
		helpers.Parser && typeof helpers.Parser.generateSuggestions === "function"
			? (filtered) => helpers.Parser.generateSuggestions(filtered)
			: undefined;
	const { data: filtered, suppressed } = fpFilter.sanitizeAnalysisData(
		data,
		makeReadFile(sourceDir),
		{ deriveSuggestions },
	);
	if (
		suppressed.security.length ||
		suppressed.layerViolations.length ||
		suppressed.hygiene.length ||
		suppressed.deadCode.length ||
		suppressed.duplicates.length
	) {
		process.stderr.write(
			`fp-filter: suppressed ${suppressed.security.length} security issue(s), ` +
				`${suppressed.layerViolations.length} layer violation(s), ` +
				`${suppressed.hygiene.length} hygiene finding(s), ` +
				`${suppressed.deadCode.length} unused function(s), ` +
				`${suppressed.duplicates.length} duplicate group(s)\n`,
		);
	}
	if (suppressed.suggestions.length) {
		process.stderr.write(
			`fp-filter: dropped ${suppressed.suggestions.length} derived suggestion(s): derivation unavailable\n`,
		);
	}

	// The coupling edges the analyzer counted are not all dependencies (see
	// fp-filter.js::pruneCouplingEdges), but the card that names them is a count
	// over that list, so pruning it without re-titling it would export a number the
	// report no longer carries. Both or neither: with no deriver — or no readable
	// connection list — nothing is pruned and `coupling: null` says so, instead of
	// implying a measurement the export does not back.
	let reportData = filtered;
	let coupling = null;
	if (Array.isArray(filtered.connections) && architectureDeriver !== null) {
		// A throw here aborts the run, like the sanitizer above.
		const pruned = fpFilter.pruneCouplingEdges(filtered, { readFile: makeReadFile(sourceDir) });
		const prunedData = Object.assign({}, filtered, { connections: pruned.connections });
		const issues = architectureDeriver(prunedData);
		if (!Array.isArray(issues)) {
			throw new Error("the analyzer's architecture deriver returned no issue list");
		}
		coupling = {
			before: fpFilter.coupledTargetCount(filtered.connections),
			after: fpFilter.coupledTargetCount(pruned.connections),
			dropped: pruned.dropped.length,
		};
		// The exporter maps `data.issues` to the report's `architectureIssues`, so the
		// deriver's list is written back there.
		reportData = Object.assign(prunedData, { issues: issues });
		if (coupling.dropped) {
			process.stderr.write(`coupling-prune: dropped ${coupling.dropped} non-dependency edge(s)\n`);
		}
	}

	const reportSrc = extractFunction(indexHtml, "generateReport");
	if (!reportSrc) {
		throw new Error("index.html does not define generateReport");
	}
	const { markdown, json } = captureExports(reportSrc, helpers, reportData, {
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

	// Stats are read from the sanitized data so the terms describe the same report
	// the exports were built from.
	const stats = filtered && filtered.stats !== undefined ? filtered.stats : null;
	process.stdout.write(
		JSON.stringify({
			markdown: markdownName,
			json: jsonName,
			analyzedAt: Date.now(),
			stats,
			terms: scoreTerms(stats),
			coupling,
		}) + "\n",
	);
}

// Only an actual `node run-analysis.mjs ...` invocation runs the producer, so a
// test can import `makeReadFile` without side effects. `argv[1]` is absent when
// the file is imported (or `-e`-run).
const SELF = fileURLToPath(import.meta.url);
let ENTRY = "";
try {
	ENTRY = fs.realpathSync(path.resolve(process.argv[1] ?? ""));
} catch {
	ENTRY = "";
}
if (ENTRY === fs.realpathSync(SELF)) {
	main().catch((error) => fail(error && error.message ? error.message : String(error)));
}
