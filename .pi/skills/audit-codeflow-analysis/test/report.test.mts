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
	classifyFinding,
	classifyKnownNoise,
	groupIssues,
	hasStructuredFindings,
	JSON_ONLY_CATEGORIES,
	parseBestReport,
	parseReport,
	parseReportJson,
	reportSectionCoverage,
	reportUnparsedItems,
	type Disposition,
	type IssueFact,
	type Target,
} from "../lib/report.ts";
import { buildFullReport, FULL_REPORT_TOTALS } from "./fixtures/full-report.mts";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.md"), "utf-8");
const FIXTURE_JSON = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.json"), "utf-8");

const byKind = (facts: IssueFact[], kind: string) => facts.filter((f) => f.kind === kind);
const tFile = (path: string): Target => ({ kind: "file", path });
const tSymbol = (name: string): Target => ({ kind: "symbol", name });
const tEdge = (from: string, to: string): Target => ({ kind: "layer-edge", from, to });
const fileTargets = (files: string[]): Target[] => files.map(tFile);

describe("parseReport (captured markdown fixture)", () => {
	const facts = parseReport(FIXTURE);

	it("keeps a path-less layer-violation item as a layer-edge target", () => {
		const arch = byKind(facts, "architecture");
		assert.deepStrictEqual(
			arch.map((a) => a.title),
			["High coupling in parser layer", "1 Architecture Violations", "Circular dependency"],
		);
		assert.deepStrictEqual(arch[0].files, ["src/parser/ast.ts", "src/ui/render.ts"]);
		// `domain → ui` carries no path; the edge keeps the item alive.
		assert.deepStrictEqual(arch[1].targets, [{ kind: "layer-edge", from: "domain", to: "ui" }]);
		assert.deepStrictEqual(arch[1].files, []);
		assert.deepStrictEqual(arch[2].files, ["src/cycle/a.ts", "src/cycle/b.ts"]);
	});

	it("projects files from targets and keeps every fact with at least one target", () => {
		for (const f of facts) {
			assert.ok(f.targets.length >= 1, `${f.id} has no target`);
			assert.deepStrictEqual(
				f.files,
				f.targets.filter((t) => t.kind === "file").map((t) => (t as { path: string }).path),
			);
		}
		assert.ok(byKind(facts, "architecture")[0].targets.every((t) => t.kind === "file"));
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

describe("parseReportJson full-category coverage", () => {
	it("yields exactly one fact per item across every JSON category", () => {
		const report = {
			architectureIssues: [
				{ title: "a", affectedFiles: ["a.ts"] },
				{ title: "b", affectedFiles: ["b.ts"] },
			],
			duplicates: [{ name: "d", type: "code", files: [{ file: "d.ts" }] }],
			layerViolations: [{ from: "f.ts", to: "t.ts", fromLayer: "x", toLayer: "y" }],
			suggestions: [{ title: "s" }],
			unusedFunctions: [{ name: "u", file: "u.ts" }],
			securityIssues: [{ severity: "high", title: "sec", path: "s.ts" }],
			patterns: [
				{ name: "p", files: ["p.ts"] },
				{ name: "ap", isAntiPattern: true, files: ["ap.ts"] },
			],
		};
		const facts = parseReportJson(JSON.stringify(report));
		assert.strictEqual(facts.length, 9, "no item may be dropped");
		assert.deepStrictEqual(
			[...new Set(facts.map((f) => f.kind))].sort(),
			[
				"anti-pattern",
				"architecture",
				"dead-code",
				"duplicate",
				"layer-violation",
				"pattern",
				"security",
				"suggestion",
			],
		);
	});
});

describe("full-report extraction (acceptance totals)", () => {
	const facts = parseReportJson(JSON.stringify(buildFullReport()));

	it("extracts one fact per item across every category", () => {
		assert.strictEqual(facts.length, FULL_REPORT_TOTALS.facts, "no item may be dropped");
		assert.strictEqual(
			dedupeIssues(facts).length,
			FULL_REPORT_TOTALS.facts,
			"no distinct fact may collapse",
		);
		const counts: Record<string, number> = {};
		for (const f of facts) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
		assert.deepStrictEqual(counts, {
			architecture: 4,
			security: 13,
			"dead-code": 16,
			duplicate: 10,
			"layer-violation": 145,
			suggestion: 7,
			pattern: 8,
			"anti-pattern": 4,
		});
	});

	it("classifies exactly the 193 bug-kind facts as bug candidates", () => {
		const bugs = facts.filter((f) => classifyFinding(f).issueType === "bug");
		assert.strictEqual(bugs.length, FULL_REPORT_TOTALS.bugCandidates);
		const routed = facts.filter((f) => classifyFinding(f).issueType !== "bug");
		assert.strictEqual(routed.length, FULL_REPORT_TOTALS.routed);
		assert.ok(
			routed.every(
				(f) =>
					f.kind === "pattern" ||
					f.kind === "anti-pattern" ||
					/Large Files|Highly Coupled/.test(f.title),
			),
			`unexpected routed facts: ${routed.map((f) => f.title).join(", ")}`,
		);
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
		// File targets project to `files`; the edge and bare symbol ride along as
		// non-file targets instead of being dropped with the item.
		assert.deepStrictEqual(facts[2].files, ["prune_test.go"]);
		assert.deepStrictEqual(facts[2].targets, [
			tFile("prune_test.go"),
			tEdge("utils", "ui"),
			tSymbol("execFn"),
		]);
	});

	it("keeps a bare symbol on the ref line as a symbol target alongside a path", () => {
		const md = [
			"## Architecture Issues",
			"",
			"### Mixed",
			"**Affected:** `doThing`, `src/a.ts`",
			"",
		].join("\n");
		const facts = parseReport(md);
		assert.deepStrictEqual(facts[0].targets, [tSymbol("doThing"), tFile("src/a.ts")]);
		assert.deepStrictEqual(facts[0].files, ["src/a.ts"]);
	});

	it("deduplicates identical targets within a single issue", () => {
		const md = [
			"## Architecture Issues",
			"",
			"### Dup",
			"**Affected:** `src/a.ts`, `utils → ui`, `utils → ui`",
			"",
		].join("\n");
		assert.deepStrictEqual(parseReport(md)[0].targets, [tFile("src/a.ts"), tEdge("utils", "ui")]);
	});

	it("recovers a lone layer edge with no files", () => {
		const facts = parseReport(
			["## Architecture Issues", "", "### Edges", "**Affected:** `utils → ui`", ""].join("\n"),
		);
		assert.strictEqual(facts.length, 1);
		assert.deepStrictEqual(facts[0].targets, [tEdge("utils", "ui")]);
		assert.deepStrictEqual(facts[0].files, []);
	});

	it("keeps two edges in source order", () => {
		const facts = parseReport(
			["## Architecture Issues", "", "### Edges", "**Affected:** `utils → ui`, `db → ui`", ""].join(
				"\n",
			),
		);
		assert.deepStrictEqual(facts[0].targets, [tEdge("utils", "ui"), tEdge("db", "ui")]);
	});

	it("treats a path-shaped edge as one edge, not two files", () => {
		const facts = parseReport(
			[
				"## Architecture Issues",
				"",
				"### Edge",
				"**Affected:** `src/a.ts → src/b.ts`",
				"",
			].join("\n"),
		);
		assert.deepStrictEqual(facts[0].targets, [tEdge("src/a.ts", "src/b.ts")]);
		assert.deepStrictEqual(facts[0].files, []);
	});

	it("strips an inlined count from a bare symbol", () => {
		const facts = parseReport(
			["## Architecture Issues", "", "### Dups", "**Affected:** `execFn (3 files)`", ""].join("\n"),
		);
		assert.deepStrictEqual(facts[0].targets, [tSymbol("execFn")]);
		assert.deepStrictEqual(facts[0].files, []);
	});

	it("keeps a comma-joined symbol token as one symbol target", () => {
		const facts = parseReport(
			[
				"## Architecture Issues",
				"",
				"### Similar",
				"**Affected:** `readSettingsCodeflowPort, readSettingsUIPort`",
				"",
			].join("\n"),
		);
		const first = facts[0].targets[0];
		assert.strictEqual(first.kind, "symbol");
		assert.match((first as { name: string }).name, /readSettingsCodeflowPort/);
	});

	it("yields no fact for an item without a target-bearing ref line", () => {
		assert.deepStrictEqual(
			parseReport(["## Architecture Issues", "", "### No ref", "Some prose.", ""].join("\n")),
			[],
		);
		assert.deepStrictEqual(
			parseReport(["## Architecture Issues", "", "### Empty", "**Affected:**", ""].join("\n")),
			[],
		);
	});

	it("ignores backticked symbols on a non-ref line", () => {
		const facts = parseReport(
			[
				"## Architecture Issues",
				"",
				"### Has file",
				"See `doThing` for details.",
				"**Affected:** `src/a.ts`",
				"",
			].join("\n"),
		);
		assert.deepStrictEqual(facts[0].targets, [tFile("src/a.ts")]);
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
		targets: fileTargets(files),
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

	it("keeps layer-edge/symbol facts (files: []) isolated from file facts", () => {
		const edge: IssueFact = {
			id: "architecture:edge",
			kind: "architecture",
			title: "157 Architecture Violations",
			targets: [tEdge("utils", "ui")],
			files: [],
		};
		const file = fact("a", ["src/a.ts"]);
		const groups = groupIssues([edge, file]);
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
		targets: fileTargets(files),
		files,
	});

	it("keeps the first of each (kind, title, targets) group in input order", () => {
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
		// (kind, title, targets) unit is canonical; the UI summary dedupes by rule.
		const stop = fact("LOW: Code Comments", ["src/a.ts"], "security");
		const debug = fact("LOW: Debug Statements", ["src/a.ts"], "security");
		const high = fact("HIGH: Hardcoded Secret", ["src/a.ts"], "security");
		const deduped = dedupeIssues([stop, stop, debug, high, stop]);
		assert.deepStrictEqual(
			deduped.map((f) => f.title),
			["LOW: Code Comments", "LOW: Debug Statements", "HIGH: Hardcoded Secret"],
		);
	});

	it("treats different targets as distinct facts and identical targets as duplicates", () => {
		const a: IssueFact = {
			id: "architecture:a",
			kind: "architecture",
			title: "Architecture Violations",
			targets: [tEdge("utils", "ui")],
			files: [],
		};
		const b: IssueFact = {
			id: "architecture:b",
			kind: "architecture",
			title: "Architecture Violations",
			targets: [tEdge("db", "ui")],
			files: [],
		};
		assert.strictEqual(dedupeIssues([a, b]).length, 2);
		assert.strictEqual(dedupeIssues([a, a, b]).length, 2);
	});
});

describe("classifyKnownNoise", () => {
	const fact = (kind: string, title: string, files: string[] = ["src/a.ts"]): IssueFact => ({
		id: `${kind}:0`,
		kind,
		title,
		targets: fileTargets(files),
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
			"## Architecture Issues\n\n### Broken\n\nNo reference line.\n",
		);
		assert.strictEqual(unreadable[0].items, 1);
		assert.strictEqual(unreadable[0].candidates, 0);
	});

	it("counts every declared item, including the path-less architecture entry", () => {
		assert.deepStrictEqual(
			reportSectionCoverage(FIXTURE).map((c) => [c.kind, c.items, c.candidates, c.unparsedItems]),
			[
				["security", 1, 1, 0],
				["dead-code", 3, 3, 0],
				["pattern", 1, 1, 0],
				["anti-pattern", 1, 1, 0],
				// `domain → ui` is now a layer-edge target, so the item is a candidate.
				["architecture", 3, 3, 0],
			],
		);
	});

	it("counts an edge-only item as parsed and a ref-less item as unparsed", () => {
		const edgeOnly = reportSectionCoverage(
			"## Architecture Issues\n\n### Edge\n\n**Affected:** `utils → ui`\n",
		);
		assert.deepStrictEqual([edgeOnly[0].items, edgeOnly[0].candidates, edgeOnly[0].unparsedItems], [1, 1, 0]);

		const refLess = reportSectionCoverage(
			"## Architecture Issues\n\n### No ref\n\nprose\n",
		);
		assert.deepStrictEqual([refLess[0].items, refLess[0].candidates, refLess[0].unparsedItems], [1, 0, 1]);
	});

	it("reports the live 7-item architecture shape as 7 candidates", () => {
		const live = [
			"## Architecture Issues",
			"",
			"### 21 Unused Functions",
			"**Affected:** `defaultFetch`, `defaultWriteFile`, `opened`",
			"",
			"### 75 Large Files",
			"**Affected:** `index.test.ts (46 fns)`, `jsonl-logger.ts (21 fns)`",
			"",
			"### 196 Highly Coupled",
			"**Affected:** `capture.test.mts (72 imports)`",
			"",
			"### 6 Duplicate Function Names",
			"**Affected:** `execFn (3 files)`, `info (4 files)`",
			"",
			"### 4 Similar Code Blocks",
			"**Affected:** `readSettingsCodeflowPort, readSettingsUIPort`",
			"",
			"### 157 Architecture Violations",
			"**Affected:** `utils → ui`, `utils → ui`",
			"",
			"### 276 High Complexity Files",
			"**Affected:** `server.py (233)`, `prune_test.go (206)`",
		].join("\n");
		const covered = reportSectionCoverage(live).find((c) => c.kind === "architecture");
		assert.deepStrictEqual(
			[covered?.items, covered?.candidates, covered?.unparsedItems],
			[7, 7, 0],
		);
	});

	it("reports every item of a whole-section drop as unparsed", () => {
		const dropped = reportSectionCoverage(
			"## Architecture Issues\n\n### Broken\n\nNo reference line.\n",
		);
		assert.strictEqual(dropped[0].items, 1);
		assert.strictEqual(dropped[0].candidates, 0);
		assert.strictEqual(dropped[0].unparsedItems, dropped[0].items);
	});

	it("keeps unparsedItems === max(0, items - candidates) for every input", () => {
		const live = [
			"## Architecture Issues",
			"",
			"### 157 Architecture Violations",
			"**Affected:** `utils → ui`",
			"",
			"### Mystery",
			"prose",
			"",
		].join("\n");
		for (const md of [FIXTURE, live, ""]) {
			for (const c of reportSectionCoverage(md)) {
				assert.strictEqual(c.unparsedItems, Math.max(0, c.items - c.candidates), c.heading);
			}
		}
	});

	it("reports no issue sections for empty or unrelated input", () => {
		assert.deepStrictEqual(reportSectionCoverage(""), []);
		assert.deepStrictEqual(reportSectionCoverage("## Summary\n\n### nothing\n"), []);
	});
});

describe("classifyFinding", () => {
	const fact = (kind: string, title: string): IssueFact => ({
		id: `${kind}:0`,
		kind,
		title,
		targets: [tSymbol(title)],
		files: [],
	});

	it("routes size/coupling/complexity metrics to chore with a reason", () => {
		for (const title of [
			"75 Large Files",
			"196 Highly Coupled",
			"276 High Complexity Files",
			"5 Large Files",
		]) {
			const r = classifyFinding(fact("architecture", title));
			assert.strictEqual(r.issueType, "chore", title);
			assert.ok(r.reason.length > 0, title);
		}
	});

	it("keeps architecture edge/duplicate findings on the bug template", () => {
		for (const title of [
			"157 Architecture Violations",
			"6 Duplicate Function Names",
			"4 Similar Code Blocks",
			"Circular dependency",
			"High coupling in parser layer",
			"21 Unused Functions",
		]) {
			assert.strictEqual(classifyFinding(fact("architecture", title)).issueType, "bug", title);
		}
	});

	it("maps the remaining kinds", () => {
		for (const kind of ["security", "dead-code", "duplicate", "layer-violation", "suggestion"]) {
			assert.strictEqual(classifyFinding(fact(kind, "x")).issueType, "bug", kind);
		}
		assert.strictEqual(classifyFinding(fact("pattern", "Singleton")).issueType, "informational");
		assert.strictEqual(classifyFinding(fact("anti-pattern", "God Object")).issueType, "chore");
	});

	it("is deterministic and always inside the union", () => {
		const all = [
			fact("architecture", "75 Large Files"),
			fact("architecture", "157 Architecture Violations"),
			fact("security", "HIGH: X"),
			fact("pattern", "Singleton"),
			fact("anti-pattern", "God Object"),
		];
		const allowed = new Set(["bug", "chore", "informational", "out-of-scope"]);
		for (const f of all) {
			const a = classifyFinding(f);
			assert.deepStrictEqual(a, classifyFinding(f));
			assert.ok(allowed.has(a.issueType), a.issueType);
		}
	});
});

describe("reportUnparsedItems", () => {
	it("names the items a section declared but could not parse", () => {
		const md = [
			"## Architecture Issues",
			"",
			"### 157 Architecture Violations",
			"**Affected:** `utils → ui`",
			"",
			"### Mystery",
			"prose only",
			"",
		].join("\n");
		assert.deepStrictEqual(reportUnparsedItems(md), [
			{ heading: "Architecture Issues", title: "Mystery" },
		]);
	});

	it("returns nothing for fully parsed or empty input", () => {
		assert.deepStrictEqual(reportUnparsedItems(""), []);
		assert.deepStrictEqual(
			reportUnparsedItems("## Architecture Issues\n\n### X\n**Affected:** `src/a.ts`\n"),
			[],
		);
	});
});

describe("triage policy is single-sourced", () => {
	const SKILL_DIR = resolve(FIXTURE_DIR, "..", "..");
	const read = (rel: string) => readFileSync(resolve(SKILL_DIR, rel), "utf-8");

	it("drops the threshold clause and points at classifyFinding", () => {
		assert.ok(!read("references/finding-validator.md").includes("size or count threshold"));
		const skill = read("SKILL.md");
		assert.ok(!skill.includes("JSON-only in practice"));
		assert.ok(!skill.includes("expected, not a parser fault"));
		assert.ok(skill.includes("classifyFinding"));
	});
});

describe("hasStructuredFindings — structured-export usability (issue #1992)", () => {
	const unusable: (string | null | undefined)[] = [
		null,
		undefined,
		"",
		"not json",
		"[]",
		"{}",
		'{"architectureIssues":[]}',
		'{"files":[]}',
		'{"architectureIssues":"nope"}',
	];
	const usable: string[] = [
		'{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"]}]}',
		'{"duplicates":[{"files":[{"file":"src/a.ts"}]}]}',
		'{"securityIssues":[{"path":"a.ts","title":"HIGH: X"}]}',
		// A bare fact still counts: keep the predicate facts-count based, matching
		// `parseBestReport` (report.ts), not a target-bearing subset.
		'{"architectureIssues":[{}]}',
	];

	it("returns false for absent, empty and facts-less bodies without throwing", () => {
		for (const text of unusable) {
			assert.strictEqual(hasStructuredFindings(text), false, String(text));
		}
	});

	it("returns true for any JSON body parseReportJson yields a fact for", () => {
		for (const text of usable) {
			assert.strictEqual(hasStructuredFindings(text), true, text);
		}
	});

	it("equals parseReportJson(text).length > 0 so it cannot drift from parseBestReport", () => {
		for (const text of [...unusable, ...usable]) {
			assert.strictEqual(
				hasStructuredFindings(text),
				parseReportJson(text ?? "").length > 0,
				String(text),
			);
		}
	});

	it("exposes the single list of markdown-invisible categories", () => {
		assert.deepStrictEqual([...JSON_ONLY_CATEGORIES], [
			"duplicate",
			"layer-violation",
			"suggestion",
		]);
	});

	it("keeps the format-sniff contract: a stub still classifies as json", () => {
		assert.strictEqual(parseReportJson('{"architectureIssues":[]}').length, 0);
	});
});

describe("parseReportJson — affectedItems[].files[].file (issue #1992)", () => {
	it("reads the nested files[].file shape for symbol-level architecture items", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{
					title: "6 Duplicate Function Names",
					affectedFiles: ["execFn (3 files)", "info (4 files)"],
					affectedItems: [
						{ files: [{ file: ".pi/extensions/supervisor/index.ts" }] },
						{ files: [{ file: ".pi/extensions/context-info/codeflow.ts" }] },
					],
				},
			],
		});
		assert.deepStrictEqual(parseReportJson(json)[0].files, [
			".pi/extensions/supervisor/index.ts",
			".pi/extensions/context-info/codeflow.ts",
		]);
	});

	it("keeps the nested path for a Similar Code Blocks item (display string is not a path)", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{
					title: "4 Similar Code Blocks",
					affectedFiles: ["readSettingsCodeflowPort, readSettingsUIPort"],
					affectedItems: [{ files: [{ file: ".pi/extensions/context-info/codeflow.ts" }] }],
				},
			],
		});
		assert.deepStrictEqual(parseReportJson(json)[0].files, [
			".pi/extensions/context-info/codeflow.ts",
		]);
	});

	it("drops non-path-like affectedFiles display strings but keeps the fact", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{
					title: "4 Similar Code Blocks",
					affectedFiles: ["readSettingsCodeflowPort, readSettingsUIPort"],
				},
			],
		});
		const facts = parseReportJson(json);
		assert.strictEqual(facts.length, 1, "the fact must survive");
		assert.deepStrictEqual(facts[0].files, []);
	});

	it("keeps a nested path that is also in affectedFiles exactly once", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{
					title: "x",
					affectedFiles: ["src/a.ts"],
					affectedItems: [{ files: [{ file: "src/a.ts" }] }],
				},
			],
		});
		assert.deepStrictEqual(parseReportJson(json)[0].files, ["src/a.ts"]);
	});

	it("ignores malformed nested files without throwing or storing empty paths", () => {
		for (const files of [
			"nope",
			[null],
			[{}],
			[{ file: null }],
			[{ file: "" }],
			[{ file: "   " }],
		]) {
			const json = JSON.stringify({
				architectureIssues: [{ title: "x", affectedItems: [{ files }] }],
			});
			const facts = parseReportJson(json);
			assert.strictEqual(facts.length, 1);
			assert.deepStrictEqual(facts[0].files, [], JSON.stringify(files));
		}
	});

	it("still reads the flat affectedItems[].file / .toFile shapes", () => {
		const json = JSON.stringify({
			architectureIssues: [
				{ title: "x", affectedItems: [{ file: "src/a.ts", toFile: "src/target.ts" }] },
			],
		});
		assert.deepStrictEqual(parseReportJson(json)[0].files, ["src/a.ts", "src/target.ts"]);
	});
});

describe("classifyFinding — disposition (issue #1992)", () => {
	const fact = (kind: string, title: string): IssueFact => ({
		id: `${kind}:0`,
		kind,
		title,
		targets: [tSymbol(title)],
		files: [],
	});

	it("assigns file-bug to every bug-template kind", () => {
		for (const kind of [
			"architecture",
			"security",
			"dead-code",
			"duplicate",
			"layer-violation",
			"suggestion",
		]) {
			const r = classifyFinding(fact(kind, "x"));
			assert.strictEqual(r.issueType, "bug", kind);
			assert.strictEqual(r.disposition, "file-bug", kind);
		}
	});

	it("assigns file-refactor to anti-patterns and every derived metric", () => {
		assert.strictEqual(classifyFinding(fact("anti-pattern", "God Object")).disposition, "file-refactor");
		for (const title of ["81 Large Files", "200 Highly Coupled", "285 High Complexity Files"]) {
			const r = classifyFinding(fact("architecture", title));
			assert.strictEqual(r.issueType, "chore", title);
			assert.strictEqual(r.disposition, "file-refactor", title);
		}
	});

	it("assigns offer-optional to patterns and drop to unknown kinds", () => {
		const pattern = classifyFinding(fact("pattern", "Singleton"));
		assert.strictEqual(pattern.issueType, "informational");
		assert.strictEqual(pattern.disposition, "offer-optional");
		const unknown = classifyFinding(fact("mystery", "x"));
		assert.strictEqual(unknown.issueType, "out-of-scope");
		assert.strictEqual(unknown.disposition, "drop");
	});

	it("is deterministic, inside the union, and always carries a reason", () => {
		const all = [
			fact("architecture", "81 Large Files"),
			fact("architecture", "157 Architecture Violations"),
			fact("security", "HIGH: X"),
			fact("pattern", "Singleton"),
			fact("anti-pattern", "God Object"),
			fact("mystery", "x"),
		];
		const allowed = new Set<Disposition>(["file-bug", "file-refactor", "offer-optional", "drop"]);
		for (const f of all) {
			const a = classifyFinding(f);
			assert.deepStrictEqual(a, classifyFinding(f));
			assert.ok(allowed.has(a.disposition), a.disposition);
			assert.ok(a.reason.length > 0, `empty reason for ${f.kind}`);
		}
	});
});

describe("classifyKnownNoise — cross-language layer violations (issue #1992)", () => {
	const lv = (files: string[]): IssueFact => ({
		id: "layer-violation:0",
		kind: "layer-violation",
		title: "domain → ui",
		targets: files.map(tFile),
		files,
	});

	it("suppresses an edge whose endpoints cannot import each other", () => {
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts", "ui/src/lib.rs"])), "suppress");
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts", "src/b.py"])), "suppress");
		assert.strictEqual(classifyKnownNoise(lv(["src/a.go", "src/b.sh"])), "suppress");
	});

	it("keeps same-family edges, including the .ts ↔ .js pair", () => {
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts", "src/b.mts"])), "keep");
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts", "src/b.js"])), "keep");
	});

	it("keeps one-file, file-less and unknown-extension edges (fail-safe)", () => {
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts"])), "keep");
		assert.strictEqual(classifyKnownNoise(lv([])), "keep");
		assert.strictEqual(classifyKnownNoise(lv(["src/a.ts", "src/b.xyz"])), "keep");
	});

	it("is symmetric in file order and deterministic", () => {
		const forward = lv(["src/a.ts", "src/b.rs"]);
		const reverse = lv(["src/b.rs", "src/a.ts"]);
		assert.strictEqual(classifyKnownNoise(forward), classifyKnownNoise(reverse));
		assert.strictEqual(classifyKnownNoise(forward), classifyKnownNoise(forward));
	});

	it("leaves non-layer-violation kinds unchanged", () => {
		assert.strictEqual(
			classifyKnownNoise({
				id: "security:0",
				kind: "security",
				title: "HIGH: X",
				targets: [],
				files: ["src/a.ts", "src/b.rs"],
			}),
			"keep",
		);
	});
});
