/**
 * Tests for .pi/skills/audit-codeflow-analysis/lib/report.ts — pure report
 * parsing and file-conflict grouping.
 *
 * The markdown and JSON fixtures are captured from the *real* CodeFlow
 * generator (see test/fixtures/generate-report-fixtures.mjs), so the parser is
 * verified against the bytes the browser export actually produces — not a
 * hand-authored approximation. Both fixtures carry the same analysis object,
 * which is why their overlapping sections must agree.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/report.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
	dedupeIssues,
	classifyKnownNoise,
	groupIssues,
	parseBestReport,
	parseReport,
	parseReportJson,
	reportSectionCoverage,
	type IssueFact,
} from "../lib/report.ts";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.md"), "utf-8");
const FIXTURE_JSON = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.json"), "utf-8");

const byKind = (facts: IssueFact[], kind: string) => facts.filter((f) => f.kind === kind);

describe("parseReport (captured markdown fixture)", () => {
	const facts = parseReport(FIXTURE);

	it("extracts architecture issues with their affected files", () => {
		const arch = byKind(facts, "architecture");
		// The real exporter prints a layer-violation issue's item as `fromLayer →
		// toLayer` (no path), which is not a file reference and is dropped here;
		// the JSON parser recovers that file from `affectedFiles`.
		assert.deepStrictEqual(
			arch.map((a) => a.title),
			["High coupling in parser layer", "Circular dependency"],
		);
		assert.deepStrictEqual(arch[0].files, ["src/parser/ast.ts", "src/ui/render.ts"]);
		assert.deepStrictEqual(arch[1].files, ["src/cycle/a.ts", "src/cycle/b.ts"]);
	});

	it("extracts dead functions with their owning file", () => {
		const dead = byKind(facts, "dead-code");
		assert.strictEqual(dead.length, 3);
		assert.deepStrictEqual(
			dead.map((d) => d.files),
			[["src/parser/legacy.ts"], ["src/util/helpers.ts"], ["src/parser/legacy.ts"]],
		);
	});

	it("extracts security issues with their file", () => {
		const sec = byKind(facts, "security");
		assert.strictEqual(sec.length, 1);
		assert.deepStrictEqual(sec[0].files, ["src/config.ts"]);
	});

	it("extracts design patterns and anti-patterns (previously unmapped headings)", () => {
		assert.deepStrictEqual(
			byKind(facts, "pattern").map((p) => p.files),
			[["src/registry.ts"]],
		);
		assert.deepStrictEqual(
			byKind(facts, "anti-pattern").map((p) => p.files),
			[["src/god.ts"]],
		);
	});

	it("returns empty for the sections the markdown exporter omits", () => {
		// These live only in the JSON export; the JSON parser must supply them.
		assert.deepStrictEqual(byKind(facts, "duplicate"), []);
		assert.deepStrictEqual(byKind(facts, "layer-violation"), []);
		assert.deepStrictEqual(byKind(facts, "suggestion"), []);
	});

	it("gives every fact a stable unique id and a non-empty title", () => {
		const ids = facts.map((f) => f.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		for (const f of facts) assert.ok(f.title.length > 0, `empty title for ${f.id}`);
	});
});

describe("parseReportJson (captured JSON fixture)", () => {
	const facts = parseReportJson(FIXTURE_JSON);

	it("extracts architecture issues from affectedFiles and affectedItems, including the layer-violation target", () => {
		const arch = byKind(facts, "architecture");
		assert.deepStrictEqual(
			arch.map((a) => a.files),
			[
				["src/parser/ast.ts", "src/ui/render.ts"],
				// `src/ui/c.ts` is only reachable via affectedItems[].toFile — the
				// generator omits it from the flattened affectedFiles.
				["src/domain/b.ts", "src/ui/c.ts"],
				["src/cycle/a.ts", "src/cycle/b.ts"],
			],
		);
	});

	it("includes affectedItems[].toFile so layer-violation targets join the conflict graph", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{
					title: "Target only",
					affectedFiles: ["src/a.ts"],
					affectedItems: [{ file: "src/a.ts", toFile: "src/target.ts" }],
				},
			],
		});
		assert.deepStrictEqual(parseReportJson(json)[0].files, ["src/a.ts", "src/target.ts"]);
	});

	it("extracts duplicates with their file list", () => {
		const dup = byKind(facts, "duplicate");
		assert.strictEqual(dup.length, 1);
		assert.match(dup[0].title, /Same Name: parseConfig/);
		assert.deepStrictEqual(dup[0].files, ["src/dup/a.ts", "src/dup/b.ts", "src/dup/c.ts"]);
	});

	it("extracts layer violations with both endpoint files", () => {
		const layer = byKind(facts, "layer-violation");
		assert.strictEqual(layer.length, 1);
		assert.deepStrictEqual(layer[0].files, ["src/layer/from.ts", "src/layer/to.ts"]);
	});

	it("extracts suggestions (file-less) and dead functions", () => {
		const sugg = byKind(facts, "suggestion");
		assert.strictEqual(sugg.length, 1);
		assert.deepStrictEqual(sugg[0].files, []);
		assert.deepStrictEqual(
			byKind(facts, "dead-code").map((d) => d.files),
			[["src/parser/legacy.ts"], ["src/util/helpers.ts"], ["src/parser/legacy.ts"]],
		);
	});

	it("extracts security issues from the structured path field", () => {
		const sec = byKind(facts, "security");
		assert.strictEqual(sec.length, 1);
		assert.deepStrictEqual(sec[0].files, ["src/config.ts"]);
	});

	it("extracts design patterns and anti-patterns from the structured patterns field", () => {
		// The markdown parser reads the Design Patterns / Anti-Patterns headings;
		// the JSON parser must carry the same categories or they vanish whenever
		// the structured artifact is present (parseBestReport prefers JSON).
		assert.deepStrictEqual(
			byKind(facts, "pattern").map((p) => [p.title, p.files]),
			[["Singleton", ["src/registry.ts"]]],
		);
		assert.deepStrictEqual(
			byKind(facts, "anti-pattern").map((p) => [p.title, p.files]),
			[["God Object", ["src/god.ts"]]],
		);
	});

	it("returns empty for empty, malformed, or non-object JSON without throwing", () => {
		assert.deepStrictEqual(parseReportJson(""), []);
		assert.deepStrictEqual(parseReportJson("not json"), []);
		assert.deepStrictEqual(parseReportJson("[]"), []);
		assert.deepStrictEqual(parseReportJson("null"), []);
		assert.deepStrictEqual(parseReportJson('{"architectureIssues": "nope"}'), []);
	});

	it("skips null and non-object array entries without aborting the parse", () => {
		// A malformed/changed report must not throw: one bad entry previously
		// aborted the whole extraction (`affectedFiles` read off null).
		assert.deepStrictEqual(parseReportJson('{"architectureIssues":[null]}'), []);
		const json = JSON.stringify({
			architectureIssues: [
				null,
				42,
				{ title: "ok", affectedFiles: ["a.ts"], affectedItems: [null, "x", { file: "b.ts" }] },
			],
			duplicates: [null, { name: "d", files: [null, { file: "d.ts" }] }],
			layerViolations: [null],
			suggestions: [null],
			unusedFunctions: [null],
			securityIssues: [null],
			patterns: [null, { name: "p", files: ["p.ts"], fileDetails: [null, { path: "pd.ts" }] }],
		});
		const facts = parseReportJson(json);
		assert.deepStrictEqual(
			byKind(facts, "architecture").map((f) => f.files),
			[["a.ts", "b.ts"]],
		);
		assert.deepStrictEqual(
			byKind(facts, "duplicate").map((f) => f.files),
			[["d.ts"]],
		);
		assert.deepStrictEqual(byKind(facts, "pattern")[0].files, ["p.ts", "pd.ts"]);
		assert.deepStrictEqual(byKind(facts, "layer-violation"), []);
		assert.deepStrictEqual(byKind(facts, "suggestion"), []);
		assert.deepStrictEqual(byKind(facts, "dead-code"), []);
		assert.deepStrictEqual(byKind(facts, "security"), []);
	});
});

describe("parseBestReport", () => {
	it("prefers the structured JSON when it yields facts", () => {
		const best = parseBestReport(FIXTURE, FIXTURE_JSON);
		assert.ok(
			best.some((f) => f.kind === "duplicate"),
			"JSON-only duplicate category missing",
		);
		assert.ok(best.some((f) => f.kind === "layer-violation"));
		// Pattern categories live in both formats; the JSON branch must not drop
		// them when it wins.
		assert.ok(
			best.some((f) => f.kind === "pattern"),
			"JSON design patterns missing",
		);
		assert.ok(
			best.some((f) => f.kind === "anti-pattern"),
			"JSON anti-patterns missing",
		);
	});

	it("falls back to markdown when JSON is absent or unusable", () => {
		assert.deepStrictEqual(parseBestReport(FIXTURE), parseReport(FIXTURE));
		assert.deepStrictEqual(parseBestReport(FIXTURE, "not json"), parseReport(FIXTURE));
	});
});

describe("parseReport (defensive)", () => {
	it("parses optional duplicate / layer-violation / suggestion sections when present", () => {
		const md = [
			"# CodeFlow Analysis Report",
			"",
			"## Duplicates",
			"",
			"### Copy of parseConfig",
			"**Files:** `src/a.ts`, `src/b.ts`",
			"",
			"## Layer Violations",
			"",
			"### UI imports DB",
			"**Affected files:** `src/db.ts`",
			"",
			"## Suggestions",
			"",
			"### Split god module",
			"**Affected:** `src/god.ts`",
			"",
		].join("\n");
		const facts = parseReport(md);
		assert.deepStrictEqual(byKind(facts, "duplicate")[0].files, ["src/a.ts", "src/b.ts"]);
		assert.deepStrictEqual(byKind(facts, "layer-violation")[0].files, ["src/db.ts"]);
		assert.deepStrictEqual(byKind(facts, "suggestion")[0].files, ["src/god.ts"]);
	});

	it("recovers paths from the counts the exporter inlines into architecture affected lists", () => {
		// Live exporter shape: items are `{ name: f.name+' ('+n+' fns)', file: f.path }`
		// and the md branch emits `x.name || x.file`, so the name carries the count.
		const md = [
			"## Architecture Issues",
			"",
			"### 74 Large Files",
			"Files with 15+ functions",
			"",
			"**Affected:** `index.test.ts (46 fns)`, `jsonl-logger.ts (21 fns)`",
			"",
			"### 193 Highly Coupled",
			"",
			"**Affected:** `capture.test.mts (73 imports)`",
			"",
			"### 275 High Complexity Files",
			"",
			"**Affected:** `prune_test.go (206)`, `utils → ui`, `execFn (3 files)`",
			"",
		].join("\n");
		const facts = parseReport(md);
		assert.deepStrictEqual(
			facts.map((f) => f.title),
			["74 Large Files", "193 Highly Coupled", "275 High Complexity Files"],
		);
		assert.deepStrictEqual(facts[0].files, ["index.test.ts", "jsonl-logger.ts"]);
		assert.deepStrictEqual(facts[1].files, ["capture.test.mts"]);
		// Bare function names, layer labels and count-only names stay dropped.
		assert.deepStrictEqual(facts[2].files, ["prune_test.go"]);
	});

	it("drops non-path backticked names (function names) from affected lists", () => {
		const md = [
			"## Architecture Issues",
			"",
			"### Mixed",
			"**Affected:** `doThing`, `src/a.ts`",
			"",
		].join("\n");
		const facts = parseReport(md);
		assert.deepStrictEqual(facts[0].files, ["src/a.ts"]);
	});

	it("deduplicates paths within a single issue", () => {
		const md = [
			"## Architecture Issues",
			"",
			"### Dup",
			"**Affected:** `src/a.ts`, `src/a.ts`",
			"",
		].join("\n");
		assert.deepStrictEqual(parseReport(md)[0].files, ["src/a.ts"]);
	});

	it("returns an empty list for empty, unknown and truncated input without throwing", () => {
		assert.deepStrictEqual(parseReport(""), []);
		assert.deepStrictEqual(parseReport("no headings here\njust prose"), []);
		assert.deepStrictEqual(
			parseReport("# CodeFlow Analysis Report\n## Architecture Issues\n### cut off"),
			[],
		);
	});
});

describe("groupIssues", () => {
	const fact = (id: string, files: string[]): IssueFact => ({
		id,
		kind: "architecture",
		title: id,
		files,
	});

	it("keeps disjoint issues in separate isolated groups", () => {
		const groups = groupIssues([fact("a", ["src/a.ts"]), fact("b", ["src/b.ts"])]);
		assert.strictEqual(groups.length, 2);
		assert.ok(groups.every((g) => g.isolated && g.overlaps.length === 0));
	});

	it("merges overlapping issues into one group and reports the shared paths", () => {
		const groups = groupIssues([
			fact("a", ["src/x.ts", "src/shared.ts"]),
			fact("b", ["src/shared.ts"]),
		]);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].isolated, false);
		assert.deepStrictEqual(groups[0].overlaps, ["src/shared.ts"]);
	});

	it("keeps file-less issues isolated instead of merging them", () => {
		const groups = groupIssues([fact("a", []), fact("b", [])]);
		assert.strictEqual(groups.length, 2);
		assert.ok(groups.every((g) => g.isolated));
	});

	it("partitions every input issue into exactly one group", () => {
		const issues = [
			fact("a", ["src/a.ts"]),
			fact("b", ["src/a.ts", "src/b.ts"]),
			fact("c", ["src/c.ts"]),
		];
		const seen = groupIssues(issues).flatMap((g) => g.issues.map((i) => i.id));
		assert.deepStrictEqual([...seen].sort(), ["a", "b", "c"]);
		assert.strictEqual(seen.length, new Set(seen).size);
	});

	it("partitions the captured JSON facts and merges the two dead-function issues", () => {
		const groups = groupIssues(parseReportJson(FIXTURE_JSON));
		const ids = groups.flatMap((g) => g.issues.map((i) => i.id));
		assert.strictEqual(ids.length, new Set(ids).size);
		const shared = groups.filter((g) => !g.isolated);
		assert.strictEqual(shared.length, 1, "only the two same-file dead functions should merge");
		assert.deepStrictEqual(shared[0].overlaps, ["src/parser/legacy.ts"]);
	});

	it("is deterministic for the same input", () => {
		const issues = parseReport(FIXTURE);
		assert.deepStrictEqual(groupIssues(issues), groupIssues(parseReport(FIXTURE)));
		assert.deepStrictEqual(
			groupIssues(parseReportJson(FIXTURE_JSON)),
			groupIssues(parseReportJson(FIXTURE_JSON)),
		);
	});
});

describe("dedupeIssues", () => {
	const fact = (title: string, files: string[], kind = "dead-code"): IssueFact => ({
		id: `${kind}:${title}`,
		kind,
		title,
		files,
	});

	it("keeps the first of each (kind, title, files) group in input order", () => {
		const issues = [
			fact("on_open()", ["src/retry.rs"]),
			fact("other()", ["src/retry.rs"]),
			fact("on_open()", ["src/retry.rs"]),
		];
		assert.deepStrictEqual(
			dedupeIssues(issues).map((f) => f.id),
			["dead-code:on_open()", "dead-code:other()"],
		);
	});

	it("keeps same-named facts that touch different files", () => {
		const issues = [fact("on_open()", ["src/a.rs"]), fact("on_open()", ["src/b.rs"])];
		assert.strictEqual(dedupeIssues(issues).length, 2);
	});

	it("treats a different kind or title as a distinct fact", () => {
		const issues = [
			fact("X", ["src/a.ts"]),
			fact("X", ["src/a.ts"], "security"),
			fact("Y", ["src/a.ts"]),
		];
		assert.strictEqual(dedupeIssues(issues).length, 3);
	});

	it("collapses repeated security findings while preserving distinct titles (canonical count)", () => {
		// Live shape: one LOW per matching line in the same file. Only the
		// (kind, title, files) unit is canonical; the UI summary dedupes by rule.
		const stop = fact("LOW: Code Comments", ["src/a.ts"], "security");
		const debug = fact("LOW: Debug Statements", ["src/a.ts"], "security");
		const high = fact("HIGH: Hardcoded Secret", ["src/a.ts"], "security");
		const deduped = dedupeIssues([stop, stop, debug, high, stop]);
		assert.deepStrictEqual(
			deduped.map((f) => f.title),
			["LOW: Code Comments", "LOW: Debug Statements", "HIGH: Hardcoded Secret"],
		);
	});
});

describe("classifyKnownNoise", () => {
	const fact = (kind: string, title: string, files: string[] = ["src/a.ts"]): IssueFact => ({
		id: `${kind}:0`,
		kind,
		title,
		files,
	});

	it("suppresses the LOW stylistic security categories, case/whitespace tolerant", () => {
		for (const title of [
			"LOW: Code Comments",
			"low:  debug statements",
			"LOW:CODE COMMENTS",
			"  LOW: Debug   Statements  ",
		]) {
			assert.strictEqual(classifyKnownNoise(fact("security", title)), "suppress", title);
		}
	});

	it("keeps every code-read security shape for the validator", () => {
		for (const title of [
			"HIGH: Hardcoded Secret",
			"HIGH: SQL Injection Risk",
			"HIGH: Shell Command Execution",
			"MEDIUM: Command Execution",
			"HIGH: Function Constructor",
		]) {
			assert.strictEqual(classifyKnownNoise(fact("security", title)), "keep", title);
		}
	});

	it("keeps every non-security kind, including file-less suggestions", () => {
		assert.strictEqual(classifyKnownNoise(fact("dead-code", "LOW: Code Comments", [])), "keep");
		assert.strictEqual(classifyKnownNoise(fact("suggestion", "LOW: Debug Statements", [])), "keep");
		assert.strictEqual(classifyKnownNoise(fact("architecture", "LOW: Code Comments")), "keep");
	});
});

describe("reportSectionCoverage", () => {
	it("flags a section that emits items but yields no candidates", () => {
		// The live architecture shape pre-fix: every affected token carries an
		// inlined count, so nothing is path-like and the whole section vanishes.
		const md = [
			"## Architecture Issues",
			"",
			"### Large Files",
			"",
			"**Affected:** `a.ts`, `b.ts`",
			"",
		].join("\n");
		const covered = reportSectionCoverage(md).find((c) => c.kind === "architecture");
		assert.deepStrictEqual(covered, {
			kind: "architecture",
			heading: "Architecture Issues",
			items: 1,
			candidates: 1,
			unparsedItems: 0,
		});

		const unreadable = reportSectionCoverage(
			"## Architecture Issues\n\n### Broken\n\n**Affected:** `x`\n",
		);
		assert.strictEqual(unreadable[0].items, 1);
		assert.strictEqual(unreadable[0].candidates, 0);
	});

	it("counts every declared item and reports the path-less architecture entry", () => {
		assert.deepStrictEqual(
			reportSectionCoverage(FIXTURE).map((c) => [c.kind, c.items, c.candidates, c.unparsedItems]),
			[
				["security", 1, 1, 0],
				["dead-code", 3, 3, 0],
				["pattern", 1, 1, 0],
				["anti-pattern", 1, 1, 0],
				// `domain → ui` carries no path in the markdown format: JSON-only.
				["architecture", 3, 2, 1],
			],
		);
	});

	it("reports every item of a whole-section drop as unparsed", () => {
		const dropped = reportSectionCoverage(
			"## Architecture Issues\n\n### Broken\n\n**Affected:** `x`\n",
		);
		assert.strictEqual(dropped[0].items, 1);
		assert.strictEqual(dropped[0].candidates, 0);
		assert.strictEqual(dropped[0].unparsedItems, dropped[0].items);
	});

	it("reports no issue sections for empty or unrelated input", () => {
		assert.deepStrictEqual(reportSectionCoverage(""), []);
		assert.deepStrictEqual(reportSectionCoverage("## Summary\n\n### nothing\n"), []);
	});
});
