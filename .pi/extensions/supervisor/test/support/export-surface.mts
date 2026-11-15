// ─── Export-Surface Analyzer (test-only support) ──────────────────
// Static TS-AST analysis that finds exports without a consumer outside their
// defining module. Split out of `dead-code-file-classification-removal.test.mts`
// (issue #2102) so the removal suite states contract facts and this analyzer —
// plus its own unit tests — live behind one test-support seam.
//
// Test-only by construction: `.mts`, not `*.test.mts`, so `node --test` never
// loads it as a suite and the scored complexity/`CODE_EXTS` metric ignores it;
// nothing outside `test/` imports it.

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/** A module that may import or re-export from the inspected target. */
export interface Consumer {
	path: string;
	source: string;
}

/** Recursively collect every .ts/.mts source file under `dir`, excluding test/. */
export function collectSourceFiles(dir: string): string[] {
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
 * Member names accessed on the namespace-import binding `nsName` in `consumer`.
 *
 * Resolves each accessor identifier with the type checker, so an identifier that
 * merely shares the name (e.g. a shadowing parameter) is not mistaken for the
 * imported namespace.
 */
function namespaceMembers(consumer: Consumer, nsName: string): string[] {
	const fileName = consumer.path;
	const sourceFile = parse(fileName, consumer.source);
	const host: ts.CompilerHost = {
		getSourceFile: (f) => (f === fileName ? sourceFile : undefined),
		getDefaultLibFileName: () => "lib.d.ts",
		writeFile: () => {},
		getCurrentDirectory: () => dirname(fileName),
		getDirectories: () => [],
		fileExists: (f) => f === fileName,
		readFile: (f) => (f === fileName ? consumer.source : undefined),
		getCanonicalFileName: (f) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
	};
	const program = ts.createProgram(
		[fileName],
		{ noResolve: true, noLib: true, target: ts.ScriptTarget.Latest },
		host,
	);
	const sf = program.getSourceFile(fileName);
	if (!sf) return [];
	const checker = program.getTypeChecker();
	let alias: ts.Symbol | undefined;
	const findAlias = (node: ts.Node): void => {
		if (
			!alias &&
			ts.isImportDeclaration(node) &&
			node.importClause?.namedBindings &&
			ts.isNamespaceImport(node.importClause.namedBindings) &&
			node.importClause.namedBindings.name.text === nsName
		) {
			alias = checker.getSymbolAtLocation(node.importClause.namedBindings.name);
		}
		ts.forEachChild(node, findAlias);
	};
	findAlias(sf);
	if (!alias) return [];
	const members: string[] = [];
	const collect = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node)) {
			if (
				ts.isIdentifier(node.expression) &&
				checker.getSymbolAtLocation(node.expression) === alias
			)
				members.push(node.name.text);
		} else if (
			ts.isElementAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			checker.getSymbolAtLocation(node.expression) === alias &&
			node.argumentExpression &&
			ts.isStringLiteral(node.argumentExpression)
		) {
			members.push(node.argumentExpression.text);
		} else if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer &&
			ts.isIdentifier(node.initializer) &&
			checker.getSymbolAtLocation(node.initializer) === alias
		) {
			// `const { phantomThing } = fc` / `const { phantomThing: x } = fc` consume
			// the namespace members named by each binding's property name.
			for (const el of node.name.elements) {
				const name = el.propertyName ?? el.name;
				if (ts.isIdentifier(name)) members.push(name.text);
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(sf);
	return members;
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
				// Namespace import: names accessed as `ns.<name>` / `ns["<name>"]`.
				for (const member of namespaceMembers(consumer, named.name.text)) names.add(member);
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

/**
 * Export names declared by a module's source, including clauses and default
 * declarations. `label` only names the module in failure messages — parsing uses
 * a synthetic file name so a caller-supplied path is never trusted for I/O.
 */
function exportedNames(source: string, label: string | undefined): string[] {
	const names: string[] = [];
	for (const st of parse("defining-module.ts", source).statements) {
		if (ts.isExportDeclaration(st)) {
			if (!st.exportClause) {
				// `export * from …` re-exports an unenumerable set → fail closed.
				throw new Error(`unsupported star re-export in ${label ?? "defining module"}`);
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

/**
 * Export names of `source` absent from every consumer source. `target` is the
 * defining module's path and is required: consumers are matched by resolving
 * their specifiers against it, so a default would silently inspect the wrong
 * file.
 */
export function unreferencedExports(
	source: string,
	consumers: Consumer[],
	target: string,
): string[] {
	const referenced = new Set<string>();
	for (const consumer of consumers) {
		for (const name of importedNames(consumer, target)) referenced.add(name);
	}
	if (referenced.has("*")) return [];
	return exportedNames(source, target).filter((name) => !referenced.has(name));
}
