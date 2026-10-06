/**
 * Tests for .pi/extensions/codeflow-analysis/report.ts — pure report parsing and
 * file-conflict grouping.
 *
 * The markdown and JSON fixtures are captured from the *real* CodeFlow
 * generator (see test/fixtures/generate-report-fixtures.mjs), so the parser is
 * verified against the bytes the browser export actually produces — not a
 * hand-authored approximation. Both fixtures carry the same analysis object,
 * which is why their overlapping sections must agree.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/codeflow-analysis/test/report.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { groupIssues, parseBestReport, parseReport, parseReportJson, type IssueFact } from "../report.ts";

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
		assert.deepStrictEqual(byKind(facts, "pattern").map((p) => p.files), [["src/registry.ts"]]);
		assert.deepStrictEqual(byKind(facts, "anti-pattern").map((p) => p.files), [["src/god.ts"]]);
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

	it("extracts architecture issues from affectedFiles, including the layer-violation issue", () => {
		const arch = byKind(facts, "architecture");
		assert.deepStrictEqual(
			arch.map((a) => a.files),
			[
				["src/parser/ast.ts", "src/ui/render.ts"],
				["src/domain/b.ts"],
				["src/cycle/a.ts", "src/cycle/b.ts"],
			],
		);
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
});

describe("parseBestReport", () => {
	it("prefers the structured JSON when it yields facts", () => {
		const best = parseBestReport(FIXTURE, FIXTURE_JSON);
		assert.ok(best.some((f) => f.kind === "duplicate"), "JSON-only duplicate category missing");
		assert.ok(best.some((f) => f.kind === "layer-violation"));
		// Pattern categories live in both formats; the JSON branch must not drop
		// them when it wins.
		assert.ok(best.some((f) => f.kind === "pattern"), "JSON design patterns missing");
		assert.ok(best.some((f) => f.kind === "anti-pattern"), "JSON anti-patterns missing");
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

	it("drops non-path backticked names (function names) from affected lists", () => {
		const md = ["## Architecture Issues", "", "### Mixed", "**Affected:** `doThing`, `src/a.ts`", ""].join("\n");
		const facts = parseReport(md);
		assert.deepStrictEqual(facts[0].files, ["src/a.ts"]);
	});

	it("deduplicates paths within a single issue", () => {
		const md = ["## Architecture Issues", "", "### Dup", "**Affected:** `src/a.ts`, `src/a.ts`", ""].join("\n");
		assert.deepStrictEqual(parseReport(md)[0].files, ["src/a.ts"]);
	});

	it("returns an empty list for empty, unknown and truncated input without throwing", () => {
		assert.deepStrictEqual(parseReport(""), []);
		assert.deepStrictEqual(parseReport("no headings here\njust prose"), []);
		assert.deepStrictEqual(parseReport("# CodeFlow Analysis Report\n## Architecture Issues\n### cut off"), []);
	});
});

describe("groupIssues", () => {
	const fact = (id: string, files: string[]): IssueFact => ({ id, kind: "architecture", title: id, files });

	it("keeps disjoint issues in separate isolated groups", () => {
		const groups = groupIssues([fact("a", ["src/a.ts"]), fact("b", ["src/b.ts"])]);
		assert.strictEqual(groups.length, 2);
		assert.ok(groups.every((g) => g.isolated && g.overlaps.length === 0));
	});

	it("merges overlapping issues into one group and reports the shared paths", () => {
		const groups = groupIssues([fact("a", ["src/x.ts", "src/shared.ts"]), fact("b", ["src/shared.ts"])]);
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
		const issues = [fact("a", ["src/a.ts"]), fact("b", ["src/a.ts", "src/b.ts"]), fact("c", ["src/c.ts"])];
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
		assert.deepStrictEqual(groupIssues(parseReportJson(FIXTURE_JSON)), groupIssues(parseReportJson(FIXTURE_JSON)));
	});
});
