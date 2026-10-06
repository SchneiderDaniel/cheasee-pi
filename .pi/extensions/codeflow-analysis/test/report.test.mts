/**
 * Tests for .pi/extensions/codeflow-analysis/report.ts — pure report parsing and
 * file-conflict grouping.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/codeflow-analysis/test/report.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { groupIssues, parseReport, type IssueFact } from "../report.ts";

const FIXTURE = readFileSync(resolve(import.meta.dirname, "fixtures", "codeflow-report.md"), "utf-8");

const byKind = (facts: IssueFact[], kind: string) => facts.filter((f) => f.kind === kind);

describe("parseReport (captured fixture)", () => {
	const facts = parseReport(FIXTURE);

	it("extracts architecture issues with their affected files", () => {
		const arch = byKind(facts, "architecture");
		assert.strictEqual(arch.length, 2);
		assert.deepStrictEqual(arch[0].files, ["src/parser/ast.ts", "src/ui/render.ts"]);
		assert.deepStrictEqual(arch[1].files, ["src/a.ts", "src/b.ts"]);
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

	it("returns empty for the sections the markdown exporter omits", () => {
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

	it("is deterministic for the same input", () => {
		const issues = parseReport(FIXTURE);
		assert.deepStrictEqual(groupIssues(issues), groupIssues(parseReport(FIXTURE)));
	});
});
