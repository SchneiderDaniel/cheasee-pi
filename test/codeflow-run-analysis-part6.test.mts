/**
 * Producer contracts for the derived `suggestions[]` cards (issue #2030).
 *
 * Split out of `codeflow-run-analysis.test.mts`, which #2035 keeps at or under the
 * 500-segment ceiling. Two contracts are owned here: the deriver port the producer
 * must supply, and the register that pins the measured before/after.
 *
 * The fixture harness is duplicated from the producer suite on purpose, so this
 * file can be run on its own and the suite it came from stays untouched.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-run-analysis-part6.test.mts
 */

import assert from "node:assert";

import { spawnSync } from "node:child_process";

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");
const ANALYZER_BLOCK = readFileSync(join(HERE, "fixtures", "codeflow-analyzer-block.txt"), "utf-8");

/** The UI export seam: only the structured JSON body matters here. */
const GENERATE_REPORT = `
function generateReport(format) {
  if (format === "json") {
    var blob = new Blob([JSON.stringify({ suggestions: data.suggestions || [{ text: "split" }], marker: data.marker, securityIssues: data.securityIssues || null, layerViolations: data.layerViolations || null, duplicates: data.duplicates || null, unusedFunctions: data.deadFunctions || null, stats: data.stats || null })], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "codeflow-report.json";
    a.click();
    URL.revokeObjectURL(url);
  } else if (format === "md") {
    var md = "# CodeFlow Analysis Report\\n\\nmarker=" + data.marker + "\\n";
    var blob2 = new Blob([md], { type: "text/markdown" });
    var url2 = URL.createObjectURL(blob2);
    var a2 = document.createElement("a");
    a2.href = url2;
    a2.download = "codeflow-report.md";
    a2.click();
    URL.revokeObjectURL(url2);
  }
}
`;

interface Fixture {
	uiDir: string;
	sourceDir: string;
	outDir: string;
}

const analysisJs = (data: unknown): string => `"use strict";
module.exports = {
  async analyze() {
    return { schemaVersion: 1, data: ${JSON.stringify(data)}, snapshot: {} };
  },
};
`;

function makeFixture(analyzerBlock: string, analysisSource: string): Fixture {
	const root = mkdtempSync(join(tmpdir(), "codeflow-runner-"));
	const uiDir = join(root, "ui");
	const sourceDir = join(root, "src");
	const outDir = join(root, "out");
	mkdirSync(join(uiDir, "card", "lib"), { recursive: true });
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(sourceDir, "a.ts"), "export const a = 1;\n");
	writeFileSync(
		join(uiDir, "index.html"),
		`<html><body><script type="text/babel">${analyzerBlock}${GENERATE_REPORT}</script></body></html>`,
	);
	writeFileSync(join(uiDir, "card", "lib", "analysis.js"), analysisSource);
	return { uiDir, sourceDir, outDir };
}

function runRunner(fx: Fixture): { code: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [RUNNER, fx.sourceDir, fx.uiDir, fx.outDir], {
		encoding: "utf-8",
	});
	return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const envelope = (stdout: string): { json: string | null } => {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
};

// Issue #2030. The pinned analyzer derives `data.suggestions` from the arrays the
// false-positive filter then shrinks, so the export shipped cards naming findings
// it did not carry. The producer must re-derive them through the analyzer's own
// `Parser.generateSuggestions` (a port — never a copy of the seven rules), and
// drop them when that function is unavailable.
describe("run-analysis — derived suggestion cards (issue #2030, Phase 3)", () => {
	const STALE = [
		{ title: "Fix Security Issues", desc: "9 high-severity security issues found." },
		{ title: "Fix Architecture Violations", desc: "375 layer violations found." },
	];
	// The analyzer's own policy is what the producer must call; this stub records
	// the call so the test proves the port is wired, not that a rule was re-made.
	const PARSER_WITH_DERIVER = `
const Parser = {
  functionKey: function (fn) { return fn.name; },
  seen: null,
  generateSuggestions: function (d) {
    Parser.seen = { layers: d.layerViolations.length, security: d.securityIssues.length };
    return [{ title: "Remove Dead Code", desc: (d.stats && d.stats.dead) + " unused functions detected." }];
  },
};
`;

	function suggestionsFixture(parser: string, data: Record<string, unknown>) {
		const block = ANALYZER_BLOCK.replace(
			"const Parser = { functionKey: function (fn) { return fn.name; } };",
			parser.trim(),
		);
		assert.ok(block.includes(parser.trim()), "the Parser stub must have been spliced in");
		return makeFixture(block, analysisJs(data));
	}

	const staleReport = () => ({
		marker: "SUGGESTIONS",
		stats: { files: 3, functions: 4, dead: 2, violations: 1 },
		suggestions: STALE,
		securityIssues: [],
		layerViolations: [],
		duplicates: [],
		files: [{ path: "a.ts", layer: "ui" }],
	});

	it("replaces the stale cards with the analyzer's re-derivation", () => {
		const fx = suggestionsFixture(PARSER_WITH_DERIVER, staleReport());
		const { code, stdout, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(
			json.suggestions,
			[{ title: "Remove Dead Code", desc: "2 unused functions detected." }],
			"the exported cards must be the deriver's verdict on the filtered data",
		);
		for (const stale of STALE) {
			assert.ok(!JSON.stringify(json).includes(stale.title), `${stale.title} must be gone`);
		}
		assert.strictEqual(envelope(stdout).json, "report.json");
		assert.doesNotMatch(stderr, /derived suggestion/, "no narration on the healthy path");
	});

	it("derives from the filtered data, not the raw report", () => {
		const data = {
			...staleReport(),
			layerViolations: [{ from: "a.ts", to: "b.ts", fromLayer: "ui", toLayer: "db" }],
			securityIssues: [
				{ severity: "high", title: "Hardcoded Secret", code: "", path: "a.ts" },
				{ severity: "low", title: "Code Comments", code: "", path: "src/widget.test.ts" },
			],
		};
		const recorder = `const Parser = {
  functionKey: function (fn) { return fn.name; },
  generateSuggestions: function (d) {
    return [{ title: "Reflect", desc: d.securityIssues.length + " security, " + d.layerViolations.length + " layers" }];
  },
};`;
		const fx = suggestionsFixture(recorder, data);
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(json.securityIssues, [], "both findings are false positives here");
		assert.deepStrictEqual(
			json.suggestions,
			[{ title: "Reflect", desc: "0 security, 0 layers" }],
			"the deriver must see the filtered arrays, never the raw report",
		);
		assert.match(stderr, /suppressed 1 security issue\(s\), 1 layer violation/);
	});

	it("drops every card and says so when the analyzer offers no deriver", () => {
		const noDeriver = `const Parser = { functionKey: function (fn) { return fn.name; } };`;
		const fx = suggestionsFixture(noDeriver, staleReport());
		const { code, stderr } = runRunner(fx);

		assert.strictEqual(code, 0, `stderr: ${stderr}`);
		const json = JSON.parse(readFileSync(join(fx.outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(json.suggestions, [], "no card may outlive its derivation");
		assert.strictEqual(
			stderr.match(/fp-filter: dropped 2 derived suggestion\(s\): derivation unavailable/g)?.length,
			1,
			`degradation must be visible exactly once, got: ${stderr}`,
		);
	});
});

// Issue #2030 register. The derived `suggestions[]` cards are one reporting defect,
// not seven code smells: the analyzer derives them before the filter drops the
// false positives, so the export shipped counts it did not carry. This pins the
// record's shape and its checkable invariants — never the drifting counts.
describe("suggestions-2030 baseline", () => {
	const FIXTURE = resolve(HERE, "fixtures", "suggestions-2030-baseline.json");
	const RECORD = resolve(
		HERE,
		"..",
		".pi/skills/audit-codeflow-analysis/references/suggestions-2030.md",
	);
	const baseline = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
		pin: string;
		derivations: { title: string; source: string }[];
		before: {
			cards: number;
			contradictions: Record<string, { desc: string; actual: string }>;
			stats: Record<string, number>;
		};
		after: { cards: number; removed: string[] };
		remeasured: { ref: string; note: string; preFilter: Record<string, number> };
		residual: { title: string; source: string; owner: string }[];
		invariants: string[];
	};

	it("pins the analyzer ref the derivation comes from", () => {
		assert.strictEqual(baseline.pin, "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1");
		const dockerfile = readFileSync(
			resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/Dockerfile"),
			"utf-8",
		);
		assert.ok(dockerfile.includes(baseline.pin), "the register pin must match the image ARG");
	});

	it("names a source array or stat for every derivation", () => {
		assert.ok(baseline.derivations.length >= 7, "the seven filed titles must be covered");
		for (const d of baseline.derivations) {
			assert.ok(d.title.length > 0);
			assert.match(d.source, /\[\]|stats\./, `${d.title} must name its source`);
		}
		for (const title of [
			"Fix Security Issues",
			"Remove Dead Code",
			"Split Large Files",
			"Extract Duplicated Code",
			"Fix Architecture Violations",
			"Reduce Coupling",
			"Resolve Naming Conflicts",
		]) {
			assert.ok(
				baseline.derivations.some((d) => d.title === title),
				`the filed title ${title} must be recorded`,
			);
		}
	});

	it("records the measured contradiction each removed card named", () => {
		assert.ok(baseline.before.cards > baseline.after.cards, "the fix must remove cards");
		for (const title of [
			"Fix Security Issues",
			"Fix Architecture Violations",
			"Extract Duplicated Code",
		]) {
			const entry = baseline.before.contradictions[title];
			assert.ok(entry, `${title} must record what it claimed`);
			assert.match(entry.desc, /\d+/, `${title} must record the shipped count`);
			assert.ok(entry.actual.length > 0, `${title} must record the surviving source`);
		}
	});

	// The audit found `before` carrying a later re-measurement instead of the filed
	// snapshot, so the literals below are the filing's own counts (issue #2030).
	// A re-measurement may exist, but only outside `before` and never asserted.
	it("pins the filed measurements in `before`, not a later re-measurement", () => {
		const filed: Record<string, string> = {
			"Fix Security Issues": "9 high-severity security issues found.",
			"Fix Architecture Violations": "375 layer violations found.",
			"Extract Duplicated Code": "3 instances of similar code found.",
			"Remove Dead Code": "44 unused functions detected.",
		};
		for (const [title, desc] of Object.entries(filed)) {
			assert.strictEqual(
				baseline.before.contradictions[title].desc,
				desc,
				`${title} must keep the count the filing shipped`,
			);
		}
		assert.strictEqual(baseline.before.stats.dead, 24, "the filed snapshot's filtered dead count");
		assert.strictEqual(baseline.before.stats.security, 0);
		assert.strictEqual(baseline.before.stats.duplicates, 0);
		assert.strictEqual(baseline.before.stats.violations, 0);

		const remeasured = baseline.remeasured;
		assert.ok(remeasured, "a later re-measurement is recorded separately, never inside `before`");
		assert.ok(remeasured.note.length > 0, "it says why it is not the filed snapshot");
		assert.ok(remeasured.ref.length > 0, "it names the revision it measured");
		assert.notStrictEqual(
			remeasured.preFilter.dead,
			baseline.before.stats.dead,
			"a re-measurement may not masquerade as the filed snapshot",
		);
	});

	it("keeps the residual cards owned by a register, never by this one", () => {
		assert.ok(baseline.residual.length > 0);
		for (const r of baseline.residual) {
			assert.ok(r.title.trim() !== "", "residual entries need a title");
			assert.ok(r.source.trim() !== "", `${r.title} needs a source`);
			assert.ok(r.owner.trim() !== "", `${r.title} needs an owner`);
			assert.ok(
				!baseline.after.removed.includes(r.title),
				`${r.title} is removed by the fix and cannot be residual`,
			);
		}
	});

	it("states checkable invariants that name a source array or stat", () => {
		assert.ok(baseline.invariants.length > 0);
		for (const invariant of baseline.invariants) {
			assert.match(invariant, /\[\]|stats\./, invariant);
		}
	});

	it("documents the derivation, reproduction, measurement, residual set and re-pin", () => {
		const doc = readFileSync(RECORD, "utf-8");
		for (const heading of [
			"## The derivation",
			"## Reproduction",
			"## Before / after",
			"## Residual set",
			"## Re-pin contract",
		]) {
			assert.ok(doc.includes(heading), `the record must carry ${heading}`);
		}
		assert.ok(doc.includes("Parser.generateSuggestions"), "the record must name the deriver");
		assert.ok(
			doc.includes("git archive HEAD | tar -x"),
			"the reproduction must snapshot the committed tree",
		);
	});
});
