import assert from "node:assert";

import { readFileSync } from "node:fs";

import { resolve } from "node:path";

import { describe, it } from "node:test";

import {
	classifyFinding,
	parseReportJson,
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
		assert.strictEqual(
			classifyFinding(fact("anti-pattern", "God Object")).disposition,
			"file-refactor",
		);
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
