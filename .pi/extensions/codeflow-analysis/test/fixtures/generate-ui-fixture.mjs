/**
 * Regenerate the CodeFlow export-control DOM fixture from the real served UI.
 *
 * The browser bridge (`_BRIDGE_JS` in server.py) locates the export button and
 * the "JSON Report" / "Markdown" menu items by DOM contract only: a button whose
 * `aria-label`/`title`/text contains "export", and `.export-option` elements
 * whose text is exactly the report label. There is no server route to query the
 * UI, so this contract cannot be discovered at runtime — it must be pinned.
 *
 * This script extracts that contract from the *actual* CodeFlow `index.html`
 * (the file the shim serves from `UI_DIR`) and writes
 * `codeflow-ui-export.html`, which `bridge.test.mts` drives mandatorily. A UI
 * relabel or restructure therefore fails the suite loudly instead of silently
 * leaving the report endpoint empty.
 *
 * Usage:
 *   CODEFLOW_UI=/path/to/codeflow/index.html node generate-ui-fixture.mjs
 *
 * Source captured from https://github.com/braedonsaunders/codeflow at
 * b0e82d127fc4990f571ebc6da6c5d9af2591aaa1 (the Dockerfile clones HEAD,
 * un-pinned; re-run this script when the fixture drifts from the served UI).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const uiPath = process.env.CODEFLOW_UI;
if (!uiPath) {
	console.error("Set CODEFLOW_UI=/path/to/codeflow/index.html");
	process.exit(2);
}
const html = readFileSync(uiPath, "utf8");

// The desktop export control: `className:'top-btn'` distinguishes it from the
// mobile variant (`top-btn mobile-icon-btn`, title 'Export'). The bridge only
// needs one control; the desktop one is what a non-mobile view renders.
function extractButton() {
	const re = /React\.createElement\('button',\{className:'([^']*)','aria-label':'Export analysis',title:'([^']*)'/g;
	let m;
	let desktop = null;
	while ((m = re.exec(html)) !== null) {
		if (m[1] === "top-btn") desktop = { cls: m[1], label: "Export analysis", title: m[2] };
	}
	if (!desktop) throw new Error("export button markup not found in " + uiPath);
	return desktop;
}

// Every `.export-option` whose click runs `generateReport('<format>')`, with the
// label rendered in its `export-option-label` child.
function extractOptions() {
	const re =
		/className:'export-option',onClick:function\(\)\{generateReport\('([a-z]+)'\)[\s\S]*?className:'export-option-label'\},'([^']+)'\)/g;
	const out = [];
	let m;
	while ((m = re.exec(html)) !== null) out.push({ format: m[1], label: m[2] });
	if (out.length === 0) throw new Error("export menu items not found in " + uiPath);
	return out;
}

const button = extractButton();
const options = extractOptions();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const lines = [
	"<!--",
	"  CodeFlow export-control DOM contract - generated, do not hand-edit.",
	"",
	"  Captured from the real served UI by generate-ui-fixture.mjs:",
	"    CODEFLOW_UI=" + uiPath,
	"    at " + new Date().toISOString(),
	"",
	"  bridge.test.mts drives the bridge against exactly this markup, so a",
	"  relabelled export button or menu item fails the suite instead of leaving",
	"  the report endpoints empty after analysis.",
	"-->",
	'<div class="topbar-actions">',
	`  <button class="${esc(button.cls)}" aria-label="${esc(button.label)}" title="${esc(button.title)}">Export</button>`,
	"</div>",
	'<div class="export-options">',
	...options.map(
		(o) =>
			`  <div class="export-option" data-report-format="${esc(o.format)}"><div class="export-option-icon"></div><div class="export-option-label">${esc(o.label)}</div></div>`,
	),
	"</div>",
	"",
];

const here = dirname(new URL(import.meta.url).pathname);
writeFileSync(join(here, "codeflow-ui-export.html"), lines.join("\n"));
console.log(
	`wrote codeflow-ui-export.html from ${uiPath}: button "${button.label}"/"${button.title}", options ${options
		.map((o) => `${o.format}="${o.label}"`)
		.join(", ")}`,
);
