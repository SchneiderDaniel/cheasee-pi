/**
 * Record the CodeFlow analysis-completion + dashboard-score seam (issue #2147).
 *
 * The served dashboard scored the raw analyzer output while the report was built
 * from filtered data, so the tab and the exported report disagreed. The fix
 * applies the false-positive filter once, at analysis completion, and lets the
 * score, the tabs and `generateReport()` all read that one snapshot. The seam
 * lives in the upstream `index.html` (not in this repo), so the rewrite in
 * `ui_rewrites.py` is anchored on its literal text — and that anchor must be
 * pinned against a real recording. A hand-written pseudo-seam would let a moved
 * upstream line silently restore the raw score.
 *
 * This script slices those anchors out of the *actual* pinned `index.html` with
 * the runner's own function slicer (one implementation, so the recording and the
 * headless producer cannot disagree about where a function ends) into
 * `codeflow-dashboard-seam.html`. Usage:
 *
 *   CODEFLOW_UI=/path/to/codeflow/index.html node generate-dashboard-seam-fixture.mjs
 *
 * Source: https://github.com/braedonsaunders/codeflow at the revision pinned by
 * `ARG CODEFLOW_REF` in cmd/cheasee-pi/embedded/docker/codeflow/Dockerfile
 * (b0e82d127fc4990f571ebc6da6c5d9af2591aaa1). Re-run when the pin moves.
 *
 * Every anchor must match; a miss exits non-zero, which is the drift guard the
 * served rewrite relies on.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { extractFunction } from "../../cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs";

// The exact revision the Dockerfile pins and the fixtures describe. Keep in sync
// with `ARG CODEFLOW_REF` in Dockerfile; the parity test enforces it.
const REVISION = process.env.CODEFLOW_REVISION ?? "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

const uiPath = process.env.CODEFLOW_UI;
if (!uiPath) {
	console.error("Set CODEFLOW_UI=/path/to/codeflow/index.html");
	process.exit(2);
}
const html = readFileSync(uiPath, "utf8");

/** Fail the recording when an upstream anchor moved or vanished. */
function must(label, found) {
	if (!found) {
		console.error(`anchor not found in ${uiPath}: ${label}`);
		process.exit(1);
	}
	return found;
}

function functionBlock(name) {
	const header = `function ${name}(`;
	return must(header, extractFunction(html, name));
}

function offsetOf(needle) {
	return html.indexOf(needle);
}

/** The whole line carrying `needle`, verbatim (indentation included). */
function lineBlock(needle) {
	const at = must(needle, offsetOf(needle) + 1) - 1;
	const from = html.lastIndexOf("\n", at) + 1;
	const to = html.indexOf("\n", at);
	return html.slice(from, to < 0 ? html.length : to);
}

/** One analysis-completion call site: the analyzer result handed to `setData`. */
function completionBlock() {
	const handle = "var dataObj=await runAnalysisData({";
	const at = must(handle, offsetOf(handle) + 1) - 1;
	const tail = "setData(dataObj);";
	const from = html.lastIndexOf("\n", at) + 1;
	const to = html.indexOf(tail, at) + tail.length;
	must(tail, to >= tail.length && to <= html.length);
	return html.slice(from, to);
}

const blocks = [
	{ id: "run-analysis-data", code: functionBlock("runAnalysisData") },
	{
		id: "dashboard-score",
		code: lineBlock("var health=useMemo(function(){return calcHealth(data);},[data]);"),
	},
	{ id: "generate-report", code: functionBlock("generateReport") },
	{ id: "analysis-completion", code: completionBlock() },
];

const lines = [
	"<!--",
	"  CodeFlow analysis-completion + dashboard-score seam - generated, do not hand-edit.",
	"",
	"  Captured from the real served UI by generate-dashboard-seam-fixture.mjs:",
	"    CODEFLOW_UI=" + uiPath,
	"    at " + new Date().toISOString(),
	"  CodeFlow revision: " + REVISION,
	"",
	"  `ui_rewrites.py` splices the false-positive filter into the analysis seam",
	"  recorded below and asserts it matches these bytes, so a moved upstream seam",
	"  fails the suite instead of silently scoring the raw analyzer output again.",
	"  Each block sits between a `;@@RECORDED:<id>@@` marker line and a",
	"  `;@@END:<id>@@` marker line, so the parity test extracts the recorded",
	"  JavaScript by id instead of parsing HTML.",
	"-->",
];
for (const block of blocks) {
	lines.push(`;@@RECORDED:${block.id}@@`, block.code, `;@@END:${block.id}@@`);
}
lines.push("");

writeFileSync(
	join(dirname(new URL(import.meta.url).pathname), "codeflow-dashboard-seam.html"),
	lines.join("\n"),
);
console.log(
	`wrote codeflow-dashboard-seam.html from ${uiPath}: ${blocks
		.map((b) => `${b.id} (${b.code.split("\n").length} lines)`)
		.join(", ")}`,
);
