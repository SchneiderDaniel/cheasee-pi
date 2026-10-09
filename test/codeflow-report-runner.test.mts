/**
 * Tests for the CodeFlow headless runner
 * (cmd/cheasee-pi/embedded/docker/codeflow/report-runner.js).
 *
 * The runner is exercised end-to-end against a synthetic CodeFlow checkout:
 * a stub `card/` module pair supplies the analysis `data`, and an `index.html`
 * carries a `generateReport` function that mimics the browser export. This
 * verifies the two behaviours the shim depends on — that `generateReport` is
 * sliced out of `index.html` and run unmodified, and that both report artifacts
 * are written from its captured Blob payloads.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-report-runner.test.mts
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const requireCjs = createRequire(import.meta.url);
const RUNNER = resolve(
	import.meta.dirname,
	"../cmd/cheasee-pi/embedded/docker/codeflow/report-runner.js",
);
const runner = requireCjs(RUNNER) as {
	extractGenerateReport(html: string): string;
};

// The function below is shaped like the browser's generateReport: it reads the
// ambient `data`, `Parser` and `calcHealth`, and downloads through Blob/URL.
const GENERATE_REPORT = `
    function generateReport(format){
        if(!data)return;
        var repo=getAnalysisSourceLabel();
        var h=calcHealth(data);
        var report={repository:repo,summary:{score:h.score},architectureIssues:data.issues};
        if(format==='json'){
            var blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
            var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='codeflow-report.json';a.click();URL.revokeObjectURL(url);
        }else if(format==='md'){
            var md='# CodeFlow Analysis Report\\n\\n';
            md+='**Repository:** '+repo+'\\n\\n';
            md+='## Summary\\n\\n';
            md+='| Metric | Value |\\n';
            md+='| Score | '+h.score+' |\\n\\n';
            var blob=new Blob([md],{type:'text/markdown'});
            var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='codeflow-report.md';a.click();URL.revokeObjectURL(url);
        }
    }
`;

/** Build a synthetic CodeFlow checkout with stubbed card modules. */
function makeCheckout(html: string): string {
	const ui = mkdtempSync(join(tmpdir(), "codeflow-runner-ui-"));
	mkdirSync(join(ui, "card", "lib"), { recursive: true });
	writeFileSync(
		join(ui, "index.html"),
		`<html><body><script>${html}\n    function nextFunction(){}</script></body></html>`,
	);
	writeFileSync(
		join(ui, "card", "lib", "analyzer.js"),
		"module.exports.loadAnalyzer = () => ({" +
			"Parser: { functionKey: () => 'k' }," +
			"calcHealth: () => ({ score: 42, grade: 'A' })," +
			"});\n",
	);
	writeFileSync(
		join(ui, "card", "lib", "analysis.js"),
		"module.exports.analyze = async () => ({ data: {" +
			"stats: { files: 3 }," +
			"issues: [{ title: 'Circular dependency', desc: 'a -> b' }]," +
			"securityIssues: [], deadFunctions: [], patterns: []," +
			"duplicates: [], layerViolations: [], suggestions: []," +
			"files: [], connections: [], folders: []" +
			"} });\n",
	);
	return ui;
}

describe("codeflow report-runner", () => {
	it("runs generateReport from index.html and writes both artifacts", () => {
		const ui = makeCheckout(GENERATE_REPORT);
		const repo = mkdtempSync(join(tmpdir(), "codeflow-runner-repo-"));
		const out = mkdtempSync(join(tmpdir(), "codeflow-runner-out-"));

		execFileSync(
			process.execPath,
			[RUNNER, "--ui", ui, "--path", repo, "--out", out, "--label", "owner/repo"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const json = JSON.parse(readFileSync(join(out, "codeflow-report.json"), "utf8"));
		assert.strictEqual(json.repository, "owner/repo");
		assert.strictEqual(json.summary.score, 42);
		assert.strictEqual(json.architectureIssues[0].title, "Circular dependency");

		const md = readFileSync(join(out, "codeflow-report.md"), "utf8");
		assert.match(md, /^# CodeFlow Analysis Report/);
		assert.match(md, /\| Score \| 42 \|/);
	});

	it("fails loudly when index.html has no generateReport", () => {
		assert.throws(
			() => runner.extractGenerateReport("<html><script>var x = 1;</script></html>"),
			/no function generateReport\(/,
		);
	});
});
