import assert from "node:assert";

import { readFileSync } from "node:fs";

import { resolve } from "node:path";

import { describe, it } from "node:test";

import {
	dedupeIssues,
	classifyFinding,
	parseBestReport,
	parseReport,
	parseReportJson,
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
		assert.deepStrictEqual([...new Set(facts.map((f) => f.kind))].sort(), [
			"anti-pattern",
			"architecture",
			"dead-code",
			"duplicate",
			"layer-violation",
			"pattern",
			"security",
			"suggestion",
		]);
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

	it("classifies exactly the 186 bug-kind facts as bug candidates", () => {
		const bugs = facts.filter((f) => classifyFinding(f).issueType === "bug");
		assert.strictEqual(bugs.length, FULL_REPORT_TOTALS.bugCandidates);
		const routed = facts.filter((f) => classifyFinding(f).issueType !== "bug");
		assert.strictEqual(routed.length, FULL_REPORT_TOTALS.routed);
		assert.ok(
			routed.every(
				(f) =>
					f.kind === "pattern" ||
					f.kind === "anti-pattern" ||
					f.kind === "suggestion" ||
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
			["## Architecture Issues", "", "### Edge", "**Affected:** `src/a.ts → src/b.ts`", ""].join(
				"\n",
			),
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
