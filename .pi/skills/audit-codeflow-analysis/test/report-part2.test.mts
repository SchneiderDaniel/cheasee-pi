import assert from "node:assert";

import { readFileSync } from "node:fs";

import { resolve } from "node:path";

import { describe, it } from "node:test";

import {
	dedupeIssues,
	classifyFinding,
	groupIssues,
	hasStructuredFindings,
	JSON_ONLY_CATEGORIES,
	parseReport,
	parseReportJson,
	reportSectionCoverage,
	reportUnparsedItems,
	type Disposition,
	type IssueFact,
	type Target,
} from "../lib/report.ts";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.md"), "utf-8");

const FIXTURE_JSON = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.json"), "utf-8");

const byKind = (facts: IssueFact[], kind: string) => facts.filter((f) => f.kind === kind);

const tFile = (path: string): Target => ({ kind: "file", path });

const tSymbol = (name: string): Target => ({ kind: "symbol", name });

const tEdge = (from: string, to: string): Target => ({ kind: "layer-edge", from, to });

const fileTargets = (files: string[]): Target[] => files.map(tFile);

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
		assert.deepStrictEqual(
			[edgeOnly[0].items, edgeOnly[0].candidates, edgeOnly[0].unparsedItems],
			[1, 1, 0],
		);

		const refLess = reportSectionCoverage("## Architecture Issues\n\n### No ref\n\nprose\n");
		assert.deepStrictEqual(
			[refLess[0].items, refLess[0].candidates, refLess[0].unparsedItems],
			[1, 0, 1],
		);
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
		assert.deepStrictEqual(
			[...JSON_ONLY_CATEGORIES],
			["duplicate", "layer-violation", "suggestion"],
		);
	});

	it("keeps the format-sniff contract: a stub still classifies as json", () => {
		assert.strictEqual(parseReportJson('{"architectureIssues":[]}').length, 0);
	});
});
