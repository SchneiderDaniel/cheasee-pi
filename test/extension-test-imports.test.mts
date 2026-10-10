/**
 * Repo-wide guard (#1858): an extension test that declares a `class` shadowing a
 * production-exported class from the same extension must import it, not
 * re-implement it. A test-local copy silently diverges from shipped behaviour.
 *
 * Class-only rule: interface shadows are benign (they carry no behaviour).
 *
 * Second guard (#1995): an extension test must not carry dead import bindings.
 * Measured against the pinned analyzer (b0e82d1), a binding only becomes a
 * coupling connection when it names a function the analyzer extracted from a
 * file whose extension it analyzes — extension tests are `.mts`, absent from
 * both its code and text extension lists, so this guard is hygiene, not a
 * score lever. Type-only, side-effect and namespace imports are exempt.
 *
 * Detection uses the TypeScript AST, so a name mentioned only in a comment or
 * string literal does not count as a use (a raw-source search would be fooled).
 *
 * Run with:
 *   node --experimental-strip-types --test test/extension-test-imports.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EXTENSIONS_DIR = join(ROOT, ".pi", "extensions");

function walkFiles(dir: string, predicate: (path: string) => boolean): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full, predicate));
		else if (predicate(full)) out.push(full);
	}
	return out;
}

/** `export [default] [abstract] class Foo` names in a source string. */
function exportedClasses(source: string): string[] {
	const names: string[] = [];
	for (const m of source.matchAll(
		/\bexport\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
	)) {
		names.push(m[1]!);
	}
	return names;
}

/** `class Foo` names in a source string. */
function declaredClasses(source: string): string[] {
	const names: string[] = [];
	for (const m of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
		names.push(m[1]!);
	}
	return names;
}

/** All names bound by `import` statements in a source string. */
function importedBindings(source: string): Set<string> {
	const names = new Set<string>();
	for (const m of source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
		for (const part of m[1]!.split(",")) {
			const trimmed = part.trim().replace(/^type\s+/, "");
			if (!trimmed) continue;
			const alias = trimmed.split(/\s+as\s+/);
			names.add((alias[1] ?? alias[0])!.trim());
		}
	}
	for (const m of source.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) {
		names.add(m[1]!);
	}
	for (const m of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
		names.add(m[1]!);
	}
	return names;
}

/**
 * A declared class whose name is production-exported for the same extension
 * but is not imported by the file.
 */
function shadowViolations(source: string, productionClasses: ReadonlySet<string>): string[] {
	const imported = importedBindings(source);
	return declaredClasses(source).filter(
		(name) => productionClasses.has(name) && !imported.has(name),
	);
}

interface ExtensionScan {
	testFiles: string[];
	productionClasses: Set<string>;
}

/**
 * Imported value bindings never referenced outside their import statement.
 *
 * Parsed with the TypeScript AST (not a text search): identifiers inside the
 * import clause are skipped, and only identifier nodes count as uses — a name
 * that appears solely in a comment, string literal or regular expression is
 * therefore reported unused. Type-only imports, side-effect imports and
 * namespace imports are exempt because they bind nothing to reference.
 */
function unusedImports(source: string, fileName = "fixture.mts"): string[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
	const bindings = new Set<string>();
	const used = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			if (!clause || clause.isTypeOnly) return;
			if (clause.name) bindings.add(clause.name.text);
			if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const spec of clause.namedBindings.elements) {
					if (spec.isTypeOnly) continue;
					bindings.add((spec.name ?? spec.propertyName)!.text);
				}
			}
			return;
		}
		if (ts.isIdentifier(node)) used.add(node.text);
		ts.forEachChild(node, visit);
	};
	file.forEachChild(visit);

	return [...bindings].filter((name) => !used.has(name));
}

function scanExtension(name: string): ExtensionScan {
	const extDir = join(EXTENSIONS_DIR, name);

	const productionClasses = new Set<string>();
	for (const file of walkFiles(extDir, (p) => /\.(ts|mts)$/.test(p))) {
		const rel = relative(extDir, file).split(/[\\/]/);
		if (rel.includes("test") || rel.includes("fixtures")) continue;
		for (const cls of exportedClasses(readFileSync(file, "utf-8"))) productionClasses.add(cls);
	}

	const testFiles = walkFiles(join(extDir, "test"), (p) => /\.test\.(ts|mts)$/.test(p));

	return { testFiles, productionClasses };
}

const scans = existsSync(EXTENSIONS_DIR)
	? readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => scanExtension(e.name))
	: [];

const allTestFiles = scans.flatMap((s) => s.testFiles);
const allProductionClasses = new Set(scans.flatMap((s) => [...s.productionClasses]));

describe("extension tests — no shadowed production classes", () => {
	it("walk found extension test files and production classes (non-vacuity)", () => {
		assert.ok(allTestFiles.length >= 1, "no extension test files found");
		assert.ok(allProductionClasses.size >= 1, "no exported production classes found");
	});

	it("detector reports an inline shadow that is not imported (falsifiable)", () => {
		assert.deepStrictEqual(
			shadowViolations("class QuestionHandler {}", new Set(["QuestionHandler"])),
			["QuestionHandler"],
		);
	});

	it("detector ignores a shadowing class that is imported", () => {
		const source =
			'import { QuestionHandler } from "../question-handler.ts";\nclass QuestionHandler {}';
		assert.deepStrictEqual(shadowViolations(source, new Set(["QuestionHandler"])), []);
	});

	it("every extension test file that shadows a production class imports it", () => {
		const violations: string[] = [];
		for (const scan of scans) {
			for (const file of scan.testFiles) {
				for (const name of shadowViolations(readFileSync(file, "utf-8"), scan.productionClasses)) {
					violations.push(`${relative(ROOT, file)}: ${name}`);
				}
			}
		}
		assert.deepStrictEqual(violations, []);
	});
});

describe("extension tests — no dead import bindings", () => {
	it("walk found extension test files (non-vacuity)", () => {
		assert.ok(allTestFiles.length >= 1, "no extension test files found");
	});

	it("detector reports an unreferenced value binding (falsifiable)", () => {
		assert.deepStrictEqual(
			unusedImports('import { used, dead } from "../x.ts";\nconsole.log(used);'),
			["dead"],
		);
	});

	it("detector ignores a name that only appears in a comment or string (AST)", () => {
		const source = [
			'import { ghost } from "../x.ts";',
			"// ghost is only mentioned in this comment",
			'const label = "ghost";',
		].join("\n");
		assert.deepStrictEqual(unusedImports(source), ["ghost"]);
	});

	it("detector ignores a binding used only in a type position", () => {
		assert.deepStrictEqual(
			unusedImports('import { Held } from "../x.ts";\nlet v: Held | null = null;'),
			[],
		);
	});

	it("detector exempts type-only, side-effect and namespace imports", () => {
		assert.deepStrictEqual(
			unusedImports(
				[
					'import type { A } from "../a.ts";',
					'import { type B } from "../b.ts";',
					'import "../side-effect.ts";',
					'import * as ns from "../ns.ts";',
				].join("\n"),
			),
			[],
		);
	});

	it("no extension test file carries an unused value import", () => {
		const violations: string[] = [];
		for (const file of allTestFiles) {
			for (const name of unusedImports(readFileSync(file, "utf-8"))) {
				violations.push(`${relative(ROOT, file)}: ${name}`);
			}
		}
		assert.deepStrictEqual(violations, []);
	});
});
