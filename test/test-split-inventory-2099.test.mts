// ─── Test-split coverage-preservation oracle (issue #2099) ────────
// Splitting a suite by behaviour unit is only safe if nothing is lost on the
// way. This oracle pins, per family, what the four cited suites executed
// *before* the split:
//
//   * the `describe` title roster (grouping names survive the move),
//   * the `it(...)` call-site count and its per-file distribution,
//   * the runtime subtest roster captured from TAP (catches the table-driven
//     `it(name, ...)` loop losing rows, which a source count cannot see),
//   * the production import surface (the split still exercises the same public
//     API — new files may only import production modules the family already
//     imported),
//   * the absence of `it.skip`/`it.todo`/`.only` (coverage cannot be disabled
//     to make the split look clean).
//
// The pinned values live in `test/fixtures/test-split-inventory-2099.json`,
// generated from the four ORIGINAL suites before editing. Post-split
// comparison is meaningless without that ordering.
//
// Run: node --experimental-strip-types --test test/test-split-inventory-2099.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUP_TEST = ".pi/extensions/supervisor/test";
const FIXTURE = "test/fixtures/test-split-inventory-2099.json";

interface FamilyInventory {
	family: string;
	dir: string;
	original: string;
	suites: string[];
	helpers: string[];
	originalSegments: number;
	describeRoster: string[];
	itCallSites: number;
	expectedItCallSites: Record<string, number>;
	productionImports: string[];
	runtimeRoster: string[];
}

const inventory = JSON.parse(readFileSync(resolve(ROOT, FIXTURE), "utf8")) as {
	issue: number;
	families: FamilyInventory[];
};

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

interface ParsedFile {
	describes: string[];
	itCallSites: number;
	topLevelDeclarations: string[];
	/** Top-level `let`/`var` names — module state shared across subtests. */
	topLevelMutableDeclarations: string[];
	/** Repo-relative paths of relative imports, resolved against the file. */
	relativeImports: string[];
}

function parseFile(rel: string): ParsedFile {
	const src = read(rel);
	const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const describes: string[] = [];
	let itCallSites = 0;
	const topLevelDeclarations: string[] = [];
	const topLevelMutableDeclarations: string[] = [];
	const relativeImports: string[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = ts.isIdentifier(callee) ? callee.text : undefined;
			if (name === "it") itCallSites++;
			if (name === "describe") {
				const arg = node.arguments[0];
				if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
					describes.push(arg.text);
				}
			}
		}
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const spec = node.moduleSpecifier.text;
			if (spec.startsWith(".")) {
				const abs = resolve(ROOT, dirname(rel), spec);
				relativeImports.push(abs.slice(ROOT.length + 1));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	for (const statement of sf.statements) {
		const named = (n: ts.Node, getName: () => ts.Identifier | undefined): void => {
			const id = getName();
			if (id) topLevelDeclarations.push(id.text);
			void n;
		};
		if (ts.isVariableStatement(statement)) {
			const declFlags = statement.declarationList.flags;
			const mutable = (declFlags & ts.NodeFlags.Let) !== 0 || (declFlags & ts.NodeFlags.Var) !== 0;
			for (const decl of statement.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) continue;
				topLevelDeclarations.push(decl.name.text);
				if (mutable) topLevelMutableDeclarations.push(decl.name.text);
			}
		} else if (ts.isFunctionDeclaration(statement)) {
			named(statement, () => statement.name);
		} else if (ts.isClassDeclaration(statement)) {
			named(statement, () => statement.name ?? undefined);
		} else if (ts.isInterfaceDeclaration(statement)) {
			named(statement, () => statement.name);
		}
	}

	return {
		describes,
		itCallSites,
		topLevelDeclarations,
		topLevelMutableDeclarations,
		relativeImports,
	};
}

/** Runtime subtest roster for `files`, captured from the TAP reporter. */
function tapRoster(files: string[]): string[] {
	// `NODE_TEST_CONTEXT` marks the process as a test-runner child; leaving it set
	// makes the nested `node --test` emit no TAP at all (silent empty roster).
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--test", "--test-reporter=tap", ...files],
		{ cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
	);
	assert.equal(
		run.status,
		0,
		`family run failed (${files.join(", ")})\n${run.stdout}\n${run.stderr}`,
	);
	const names: string[] = [];
	for (const line of run.stdout.split("\n")) {
		const hit = /^\s*ok \d+ - (.*)$/.exec(line);
		if (hit) names.push(hit[1]!);
	}
	assert.ok(names.length > 0, `no TAP results parsed for ${files.join(", ")}`);
	return names.sort();
}

/**
 * Helper modules a family's suites import out of `test/helper/`.
 *
 * `helper/mock-github-port.ts` is excluded: it is the repo-wide GitHubPort stub
 * that pre-dates this split, shared by many suites, not a fixture extracted for
 * a family. Only the family-local fixture modules are pinned.
 */
const SHARED_HELPER_MOCKS = new Set(["helper/mock-github-port.ts"]);

function importedHelpers(parsed: Map<string, ParsedFile>): string[] {
	const found = new Set<string>();
	for (const file of parsed.values()) {
		for (const rel of file.relativeImports) {
			if (!rel.startsWith(`${SUP_TEST}/helper/`)) continue;
			const helper = rel.slice(SUP_TEST.length + 1);
			if (!SHARED_HELPER_MOCKS.has(helper)) found.add(helper);
		}
	}
	return [...found].sort();
}

describe("test-split inventory #2099 — the fixture describes the four cited suites", () => {
	it("names the four suites the issue cited, and not fp-filter.js", () => {
		assert.equal(inventory.issue, 2099);
		assert.deepEqual(
			inventory.families.map((f) => f.family),
			["developer-pr", "gh-client", "octokit-client", "validation"],
		);
		for (const family of inventory.families) {
			assert.ok(!family.original.endsWith("fp-filter.js"), "fp-filter.js is not a test suite");
		}
	});

	it("pins the pre-split measurements the plan recorded", () => {
		const segments = Object.fromEntries(
			inventory.families.map((f) => [f.family, f.originalSegments]),
		);
		assert.deepEqual(segments, {
			"developer-pr": 578,
			"gh-client": 538,
			"octokit-client": 567,
			validation: 543,
		});
		const callSites = Object.fromEntries(inventory.families.map((f) => [f.family, f.itCallSites]));
		assert.deepEqual(callSites, {
			"developer-pr": 19,
			"gh-client": 36,
			"octokit-client": 29,
			validation: 24,
		});
		assert.equal(
			inventory.families.reduce((sum, f) => sum + f.itCallSites, 0),
			108,
			"108 `it()` call sites must survive the split",
		);
	});

	it("the inventory fixture is a fixture, never a suite", () => {
		assert.ok(FIXTURE.endsWith(".json"));
		assert.ok(!FIXTURE.includes(".test."), `${FIXTURE} must not match the runner glob`);
	});
});

for (const family of inventory.families) {
	describe(`test-split inventory #2099 — ${family.family}`, () => {
		const paths = family.suites.map((name) => `${family.dir}/${name}`);
		const parsed = new Map<string, ParsedFile>();
		for (const rel of paths) {
			if (existsSync(resolve(ROOT, rel))) parsed.set(rel, parseFile(rel));
		}

		it("the split landed exactly the expected sibling files", () => {
			for (const rel of paths) assert.ok(existsSync(resolve(ROOT, rel)), `missing: ${rel}`);
			assert.deepEqual([...parsed.keys()], paths, "a pinned family file is missing from the split");
		});

		it("`describe` title roster survives the move", () => {
			const titles = [...parsed.values()].flatMap((p) => p.describes).sort();
			assert.deepEqual(
				titles,
				[...family.describeRoster].sort(),
				"a describe group was renamed or dropped by the split",
			);
		});

		it("no `it()` assertion was dropped or duplicated", () => {
			const total = [...parsed.values()].reduce((sum, p) => sum + p.itCallSites, 0);
			assert.equal(total, family.itCallSites, `expected ${family.itCallSites} it() call sites`);
		});

		it("each file carries the architecture's share of the assertions", () => {
			const actual = Object.fromEntries(
				[...parsed.entries()].map(([rel, p]) => [rel.slice(family.dir.length + 1), p.itCallSites]),
			);
			assert.deepEqual(actual, family.expectedItCallSites);
		});

		it("the runtime subtest roster is identical to the pre-split run", () => {
			// Catches the table-driven `it(name, ...)` loop losing rows: a source
			// count sees one call site no matter how many rows it feeds.
			assert.deepEqual(tapRoster(paths), [...family.runtimeRoster].sort());
		});

		it("coverage is not disabled with skip/todo/only", () => {
			for (const rel of [...paths, ...family.helpers.map((h) => `${SUP_TEST}/${h}`)]) {
				const src = read(rel);
				assert.equal(
					/\b(?:it|describe|test)\.(?:skip|todo|only)\b/.test(src),
					false,
					`${rel} disables coverage with skip/todo/only`,
				);
			}
		});

		it("the production import surface is unchanged", () => {
			const production = new Set<string>();
			for (const file of parsed.values()) {
				for (const rel of file.relativeImports) {
					if (!rel.startsWith(`${SUP_TEST}/`)) production.add(rel);
				}
			}
			for (const helper of family.helpers) {
				for (const rel of parseFile(`${SUP_TEST}/${helper}`).relativeImports) {
					if (!rel.startsWith(`${SUP_TEST}/`)) production.add(rel);
				}
			}
			assert.deepEqual([...production].sort(), [...family.productionImports].sort());
		});

		it("fixtures live in test/helper modules the runner cannot load as suites", () => {
			assert.deepEqual(importedHelpers(parsed), [...family.helpers].sort());
			for (const helper of family.helpers) {
				assert.ok(!helper.includes(".test."), `${helper} matches the runner glob`);
				const src = read(`${SUP_TEST}/${helper}`);
				assert.equal(/\bdescribe\s*\(/.test(src), false, `${helper} declares a describe`);
				assert.equal(/\bit\s*\(/.test(src), false, `${helper} declares an it`);
				assert.deepEqual(
					parseFile(`${SUP_TEST}/${helper}`).topLevelMutableDeclarations,
					[],
					`${helper} holds mutable module state shared across subtests`,
				);
			}
		});

		it("top-level declarations are disjoint across the family", () => {
			const seen = new Map<string, string>();
			for (const [rel, file] of parsed) {
				for (const name of file.topLevelDeclarations) {
					const previous = seen.get(name);
					assert.equal(
						previous,
						undefined,
						`${name} is declared in both ${previous} and ${rel} — fixtures were copy-pasted`,
					);
					seen.set(name, rel);
				}
			}
		});
	});
}
