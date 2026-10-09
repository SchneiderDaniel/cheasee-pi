#!/usr/bin/env node
// Headless CodeFlow analysis runner — the API path behind POST /api/analysis/run.
//
// The browser bridge captures exports the UI builds client-side. This script
// produces the same two artifacts without a browser, by running CodeFlow's own
// analyzer (card/, the GitHub Action package that ships the headless pipeline)
// and then calling the UI's generateReport() with stub browser globals.
//
// No report mapping is duplicated here. generateReport() is sliced out of the
// served index.html and executed as-is, so the artifacts cannot drift from what
// the Export menu produces. Blob/URL/document are stubbed to capture the two
// payloads instead of downloading them.
//
// Input files are a committed-HEAD checkout prepared by the shim (git archive),
// matching the immutable snapshot the shim serves to the browser.
//
// Usage:
//   node report-runner.js --path <repoRoot> --out <dir> [--ui <dir>]
//                         [--exclude <pattern>]... [--label <name>]
//
// Writes <out>/codeflow-report.json and <out>/codeflow-report.md, then prints
// a single JSON line to stdout: {"files": <n>, "analyzedAt": <epoch-ms>}.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEFAULT_UI_DIR = process.env.UI_DIR || "/opt/codeflow-ui";
const GENERATE_REPORT = "function generateReport(";

/**
 * Slice the generateReport function out of index.html.
 *
 * The function is a top-level declaration in the app script; the next top-level
 * `function ` at the same indentation terminates it. Extraction is deliberate
 * source surgery: upstream owns the mapping, and a silent fallback here would
 * produce a report the browser never would. Missing markers throw.
 */
function extractGenerateReport(html) {
	const start = html.indexOf(GENERATE_REPORT);
	if (start < 0) {
		throw new Error(`index.html has no ${GENERATE_REPORT.trim()} declaration`);
	}
	const lineStart = html.lastIndexOf("\n", start) + 1;
	const indent = html.slice(lineStart, start);
	const end = html.indexOf(`\n${indent}function `, start + GENERATE_REPORT.length);
	if (end < 0) {
		throw new Error("could not find the end of generateReport in index.html");
	}
	return html.slice(start, end);
}

/**
 * Run the extracted generateReport for one format and return the captured
 * text. `data`, `Parser` and `calcHealth` come from the analyzer modules; the
 * browser globals it touches are stubbed.
 */
function captureReport({ source, format, data, Parser, calcHealth, label }) {
	const captured = [];
	const context = {
		console,
		data,
		Parser,
		calcHealth,
		getAnalysisSourceLabel: () => label,
		showNotification: () => {},
		Blob: class Blob {
			constructor(parts) {
				this._text = parts.join("");
			}
			text() {
				return Promise.resolve(this._text);
			}
		},
		URL: {
			createObjectURL: (blob) => {
				captured.push(blob._text);
				return "blob:codeflow-runner";
			},
			revokeObjectURL: () => {},
		},
		document: { createElement: () => ({ href: "", download: "", click: () => {} }) },
	};
	vm.createContext(context);
	vm.runInContext(source, context);
	vm.runInContext(`generateReport(${JSON.stringify(format)});`, context);
	if (captured.length !== 1) {
		throw new Error(`generateReport(${format}) produced ${captured.length} exports, expected 1`);
	}
	return captured[0];
}

function parseArgs(argv) {
	const parsed = {
		path: null,
		out: null,
		ui: DEFAULT_UI_DIR,
		exclude: [],
		label: "local/workspace",
	};
	const readValue = (index, flag) => {
		if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
		return argv[index + 1];
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--path") {
			parsed.path = readValue(index, arg);
			index++;
		} else if (arg === "--out") {
			parsed.out = readValue(index, arg);
			index++;
		} else if (arg === "--ui") {
			parsed.ui = readValue(index, arg);
			index++;
		} else if (arg === "--label") {
			parsed.label = readValue(index, arg);
			index++;
		} else if (arg === "--exclude") {
			parsed.exclude.push(readValue(index, arg));
			index++;
		} else if (arg.startsWith("--path=")) {
			parsed.path = arg.slice("--path=".length);
		} else if (arg.startsWith("--out=")) {
			parsed.out = arg.slice("--out=".length);
		} else if (arg.startsWith("--ui=")) {
			parsed.ui = arg.slice("--ui=".length);
		} else if (arg.startsWith("--label=")) {
			parsed.label = arg.slice("--label=".length);
		} else if (arg.startsWith("--exclude=")) {
			parsed.exclude.push(arg.slice("--exclude=".length));
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!parsed.path) throw new Error("--path is required");
	if (!parsed.out) throw new Error("--out is required");
	return parsed;
}

async function run(opts) {
	const uiDir = path.resolve(opts.ui);
	const htmlPath = path.join(uiDir, "index.html");
	const html = fs.readFileSync(htmlPath, "utf8");
	const { loadAnalyzer } = require(path.join(uiDir, "card", "lib", "analyzer.js"));
	const { analyze } = require(path.join(uiDir, "card", "lib", "analysis.js"));

	const { Parser, calcHealth } = loadAnalyzer(htmlPath);
	const { data } = await analyze({
		repoRoot: opts.path,
		exclude: opts.exclude,
		indexHtmlPath: htmlPath,
		progress: (message) => process.stderr.write(`[codeflow-runner] ${message}\n`),
	});

	const source = extractGenerateReport(html);
	const shared = { source, data, Parser, calcHealth, label: opts.label };
	const json = captureReport({ ...shared, format: "json" });
	const md = captureReport({ ...shared, format: "md" });

	fs.mkdirSync(opts.out, { recursive: true });
	fs.writeFileSync(path.join(opts.out, "codeflow-report.json"), json);
	fs.writeFileSync(path.join(opts.out, "codeflow-report.md"), md);
	process.stdout.write(
		`${JSON.stringify({ files: (data.stats && data.stats.files) || 0, analyzedAt: Date.now() })}\n`,
	);
}

async function main(argv) {
	const opts = parseArgs(argv || process.argv.slice(2));
	await run(opts);
}

if (require.main === module) {
	main().catch((error) => {
		process.stderr.write(
			`[codeflow-runner] error: ${(error && (error.stack || error.message)) || error}\n`,
		);
		process.exitCode = 1;
	});
}

module.exports = { extractGenerateReport, captureReport, parseArgs, run, main };
