/**
 * Tests for the dead-code removal in checks/file-classification.ts —
 * proves TEST_NAME_PATTERNS / classifyChangedFiles and their cascade
 * (isTestFile, TEST_EXTENSIONS, unused node:path import) are gone, and
 * that the retained isTestableFile contract is unchanged.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-file-classification-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import ts from "typescript";

const testDir = dirname(fileURLToPath(import.meta.url));
const checksDir = join(testDir, "..", "checks");
const classificationPath = join(checksDir, "file-classification.ts");

/** Recursively collect every .ts/.mts source file under checks/, excluding test/. */
function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "test" || entry.name === "node_modules") continue;
			out.push(...collectSourceFiles(full));
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
			out.push(full);
		}
	}
	return out;
}

/** Count source files (outside test/) containing the literal needle. */
function scanSources(needle: string): string[] {
	return collectSourceFiles(checksDir).filter((f) => readFileSync(f, "utf8").includes(needle));
}

interface Consumer {
	path: string;
	source: string;
}

/** Parse a source string with the TypeScript compiler for AST-based import/export analysis. */
function parse(fileName: string, source: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Whether a relative specifier used in `fromFile` resolves to `target`. */
function resolvesTo(specifier: string, fromFile: string, target: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const resolved = resolve(dirname(fromFile), specifier);
	return resolved === target || `${resolved}.ts` === target;
}

/**
 * Names the consumer imports/re-exports from `target`, or `"*"` when it
 * re-exports the module wholesale (`export * …`), which references every name.
 */
function importedNames(consumer: Consumer, target: string): Set<string> {
	const names = new Set<string>();
	const sourceFile = parse(consumer.path, consumer.source);
	for (const st of sourceFile.statements) {
		if (ts.isImportDeclaration(st)) {
			if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
			if (!resolvesTo(st.moduleSpecifier.text, consumer.path, target)) continue;
			if (st.importClause?.name) names.add("default");
			const named = st.importClause?.namedBindings;
			if (named && ts.isNamedImports(named)) {
				// Imported export name is the spec before any `as` alias.
				for (const el of named.elements) names.add((el.propertyName ?? el.name).text);
			} else if (named && ts.isNamespaceImport(named)) {
				// Namespace import: the names used are `ns.<name>` / `ns["<name>"]` accesses.
				const ns = named.name.text;
				const isNsExpr = (node: ts.Expression): boolean =>
					ts.isIdentifier(node) && node.text === ns;
				const collect = (node: ts.Node): void => {
					if (ts.isPropertyAccessExpression(node) && isNsExpr(node.expression)) {
						names.add(node.name.text);
					} else if (
						ts.isElementAccessExpression(node) &&
						isNsExpr(node.expression) &&
						node.argumentExpression &&
						ts.isStringLiteral(node.argumentExpression)
					) {
						names.add(node.argumentExpression.text);
					}
					ts.forEachChild(node, collect);
				};
				collect(sourceFile);
			}
		} else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
			if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
			if (!resolvesTo(st.moduleSpecifier.text, consumer.path, target)) continue;
			const clause = st.exportClause;
			if (clause && ts.isNamedExports(clause)) {
				for (const el of clause.elements) names.add((el.propertyName ?? el.name).text);
			} else {
				// `export * from …` / `export * as ns from …` re-export every name.
				names.add("*");
			}
		}
	}
	return names;
}

/** Identifier names bound by a binding name (including destructuring patterns). */
function bindingNames(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	const out: string[] = [];
	for (const el of name.elements) {
		if (ts.isOmittedExpression(el)) continue;
		out.push(...bindingNames(el.name));
	}
	return out;
}

/** Export names declared by a module's source, including clauses and default declarations. */
function exportedNames(fileName: string, source: string): string[] {
	const names: string[] = [];
	for (const st of parse(fileName, source).statements) {
		if (ts.isExportDeclaration(st)) {
			if (!st.exportClause) {
				// `export * from …` re-exports an unenumerable set → fail closed.
				throw new Error(`unsupported star re-export in ${fileName}`);
			}
			if (ts.isNamedExports(st.exportClause)) {
				for (const el of st.exportClause.elements) names.push(el.name.text);
			} else if (ts.isNamespaceExport(st.exportClause)) {
				names.push(st.exportClause.name.text);
			}
			continue;
		}
		if (ts.isExportAssignment(st)) {
			names.push("default");
			continue;
		}
		const modifiers = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
		if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
		if (ts.isVariableStatement(st)) {
			for (const d of st.declarationList.declarations) {
				names.push(...bindingNames(d.name));
			}
		} else if (
			ts.isFunctionDeclaration(st) ||
			ts.isClassDeclaration(st) ||
			ts.isInterfaceDeclaration(st) ||
			ts.isTypeAliasDeclaration(st) ||
			ts.isEnumDeclaration(st) ||
			ts.isModuleDeclaration(st)
		) {
			// `export default function f()` exports the public name `default`.
			if (isDefault) names.push("default");
			else if (st.name && ts.isIdentifier(st.name)) names.push(st.name.text);
		}
	}
	return names;
}

/** Export names of `source` absent from every consumer source (defining file excluded). */
function unreferencedExports(
	source: string,
	consumers: Consumer[],
	target: string = classificationPath,
): string[] {
	const referenced = new Set<string>();
	for (const consumer of consumers) {
		for (const name of importedNames(consumer, target)) referenced.add(name);
	}
	if (referenced.has("*")) return [];
	return exportedNames(target, source).filter((name) => !referenced.has(name));
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: removed symbols are gone and leave no dangling references
// ═══════════════════════════════════════════════════════════════════════

describe("file-classification dead-code removal", () => {
	for (const name of [
		"classifyChangedFiles",
		"TEST_NAME_PATTERNS",
		"isTestFile",
		"TEST_EXTENSIONS",
	]) {
		it(`no source under checks/ (outside test/) references ${name}`, () => {
			assert.deepEqual(scanSources(name), [], `dangling ${name} reference found`);
		});
	}

	it("removed exports are gone from the module surface", async () => {
		const mod = (await import("../checks/file-classification.ts")) as Record<string, unknown>;
		assert.equal("classifyChangedFiles" in mod, false);
		assert.equal("isTestFile" in mod, false);
	});

	it("drops the orphaned node:path import after the cascade", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.equal(source.includes("extname"), false, "extname still imported");
		assert.equal(source.includes("basename"), false, "basename still imported");
	});

	it("retains SOURCE_EXTENSIONS and exports isTestableFile", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.ok(source.includes("SOURCE_EXTENSIONS"));
		assert.ok(source.includes("export function isTestableFile"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Dead-export guard: every export needs a consumer outside its own file
// ═══════════════════════════════════════════════════════════════════════

describe("file-classification export surface", () => {
	const consumers = (): Consumer[] =>
		collectSourceFiles(checksDir)
			.filter((f) => f !== classificationPath)
			.map((f): Consumer => ({ path: f, source: readFileSync(f, "utf8") }));

	/** A synthetic consumer source at a path below checks/. */
	const consumer = (path: string, source: string): Consumer => ({ path, source });
	const synthetic = "export function phantomThing(): void {}\n";

	it("every export has a consumer outside the defining file", () => {
		const unreferenced = unreferencedExports(readFileSync(classificationPath, "utf8"), consumers());
		assert.deepEqual(unreferenced, [], `unreferenced export(s): ${unreferenced.join(", ")}`);
	});

	it("reports a synthetic export with no consumer as unreferenced", () => {
		assert.deepEqual(
			unreferencedExports(synthetic, [
				consumer(join(checksDir, "a.ts"), "import { other } from './x.ts';\n"),
			]),
			["phantomThing"],
		);
	});

	it("does not count a comment-only mention as a consumer", () => {
		const commentOnly = '/* import { phantomThing } from "../file-classification.ts"; */\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [
				consumer(join(checksDir, "requirements", "x.ts"), commentOnly),
			]),
			["phantomThing"],
		);
	});

	it("does not count a similarly named module as a consumer", () => {
		const neighbour = 'import { phantomThing } from "./file-classification-helpers.ts";\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [consumer(join(checksDir, "a.ts"), neighbour)]),
			["phantomThing"],
		);
	});

	it("does not count a specifier that resolves to a different file", () => {
		// From checks/requirements/, "./file-classification.ts" is a different module.
		const sibling = 'import { phantomThing } from "./file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [
				consumer(join(checksDir, "requirements", "x.ts"), sibling),
			]),
			["phantomThing"],
		);
	});

	it("counts an aliased import as a consumer of the imported name", () => {
		const aliased = 'import { phantomThing as classify } from "../file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [
				consumer(join(checksDir, "requirements", "parity.ts"), aliased),
			]),
			[],
		);
	});

	it("recognizes re-export clauses and default declarations as exports", () => {
		assert.deepEqual(unreferencedExports("export { phantomThing };\n", []), ["phantomThing"]);
		assert.deepEqual(
			unreferencedExports("export default function phantomThing(): void {}\n", []),
			["default"],
		);
	});

	it("recognizes a namespace export as an export", () => {
		assert.deepEqual(unreferencedExports('export * as phantomThing from "./x.ts";\n', []), [
			"phantomThing",
		]);
	});

	it("fails closed on an unsupported star export in the defining module", () => {
		assert.throws(() => unreferencedExports('export * from "./x.ts";\n', []), /star re-export/);
	});

	it("counts a default import as a consumer of the default export", () => {
		const defaultSource = "export default function phantomThing(): void {}\n";
		const importer = 'import phantomThing from "../file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(defaultSource, [
				consumer(join(checksDir, "requirements", "parity.ts"), importer),
			]),
			[],
		);
	});

	it("counts a namespace import's member access as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst ok = fc.phantomThing;\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [consumer(join(checksDir, "a.ts"), importer)]),
			[],
		);
	});

	it("counts a computed namespace member access as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst ok = fc["phantomThing"];\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [consumer(join(checksDir, "a.ts"), importer)]),
			[],
		);
	});

	it("recognizes destructured exported bindings as exports", () => {
		assert.deepEqual(unreferencedExports("export const { phantomThing } = value;\n", []), [
			"phantomThing",
		]);
		assert.deepEqual(unreferencedExports("export const [phantomThing] = list;\n", []), [
			"phantomThing",
		]);
	});

	it("counts a star re-export as a consumer", () => {
		const importer = 'export * from "./file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(synthetic, [consumer(join(checksDir, "a.ts"), importer)]),
			[],
		);
	});

	it("excludes the defining file so isTestableFile cannot self-satisfy", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.ok(unreferencedExports(source, []).includes("isTestableFile"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: retained isTestableFile contract unchanged
// ═══════════════════════════════════════════════════════════════════════

describe("retained isTestableFile contract", () => {
	it("behaves identically via direct module and shim re-export", async () => {
		const direct = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		const shim = (await import("../checks/requirements-traceability.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const mod of [direct, shim]) {
			assert.equal(mod.isTestableFile("src/foo.ts"), true);
			assert.equal(mod.isTestableFile("src/foo.d.ts"), false);
			assert.equal(mod.isTestableFile(""), false);
		}
	});
});
