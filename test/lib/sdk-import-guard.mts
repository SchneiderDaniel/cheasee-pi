/**
 * SDK static-import resolution guard (issue #1899).
 *
 * A static (top-level) import of a specifier that the pinned `@earendil-works/*`
 * package does not export — or of a named export it does not define — aborts
 * extension load before any command runs. This detector makes that drift
 * fail CI instead of silently bricking an extension.
 *
 * Two halves:
 *  - `extractSdkStaticImports(source)` — pure parser, no I/O.
 *  - `findSdkImportViolations(imports, resolve)` — pure checker; the caller
 *    injects the (impure) dynamic-import resolver.
 *
 * Expectations are derived from live `import()`, never a hand-copied exports
 * list, so the guard cannot itself go stale.
 */

import ts from "typescript";

/** Scope that a drift guard owns. */
const SDK_SCOPE = "@earendil-works/";

/** One named/default binding of a static import. */
export interface SdkImportBinding {
	/** Imported (exported) name; `"default"` for default imports. */
	name: string;
	/** `import type { X }` or `import { type X }` — erased at runtime. */
	typeOnly: boolean;
}

/** A static import of an `@earendil-works/*` specifier. */
export interface SdkStaticImport {
	specifier: string;
	bindings: SdkImportBinding[];
	/** Populated by callers that know the source file. */
	file?: string;
}

/** A specifier that does not resolve, or a value binding it lacks. */
export interface SdkImportViolation {
	file?: string;
	specifier: string;
	reason: string;
	missingBindings?: string[];
}

/** A resolved module namespace (or a compatible stand-in). */
export type SdkNamespace = Record<string, unknown>;

/** Injected resolver: the impure boundary. May be sync or async. */
export type SdkModuleResolver = (specifier: string) => SdkNamespace | Promise<SdkNamespace>;

function parseBindings(clause: ts.ImportClause | undefined): SdkImportBinding[] {
	if (clause === undefined) return []; // side-effect import: no bindings

	const statementTypeOnly = clause.isTypeOnly;
	const bindings: SdkImportBinding[] = [];

	if (clause.name !== undefined) {
		bindings.push({ name: "default", typeOnly: statementTypeOnly });
	}

	const named = clause.namedBindings;
	// `* as ns` forges a namespace object; it always exists once the specifier
	// resolves, so there is nothing to check.
	if (named !== undefined && ts.isNamedImports(named)) {
		for (const element of named.elements) {
			bindings.push({
				name: element.propertyName?.text ?? element.name.text,
				typeOnly: statementTypeOnly || element.isTypeOnly,
			});
		}
	}

	return bindings;
}

/**
 * Pure: every static import of an `@earendil-works/*` specifier in `source`.
 * Non-SDK, relative, `node:` and bare non-SDK specifiers are ignored.
 *
 * Parses with the TypeScript compiler instead of a regex + hand-rolled lexer:
 * only a real parser can tell an `import` statement from the same text
 * embedded in a comment, string literal, or template literal. An earlier
 * regex version flagged documentation examples and dropped bindings that
 * followed an inline comment — both hid or invented SDK drift.
 */
export function extractSdkStaticImports(source: string): SdkStaticImport[] {
	if (typeof source !== "string" || source.trim() === "") return [];

	const file = ts.createSourceFile(
		"extension.mts",
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	);

	const imports: SdkStaticImport[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (specifier.startsWith(SDK_SCOPE)) {
				imports.push({ specifier, bindings: parseBindings(node.importClause) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	return imports;
}

/**
 * Pure: check each import against the namespace returned by `resolve`.
 * A specifier that fails to resolve (or a value binding absent from the
 * resolved namespace) yields one violation. Type-only bindings are erased at
 * runtime and never checked.
 */
export async function findSdkImportViolations(
	imports: SdkStaticImport[],
	resolve: SdkModuleResolver,
): Promise<SdkImportViolation[]> {
	const violations: SdkImportViolation[] = [];

	for (const imp of imports) {
		let namespace: SdkNamespace;
		try {
			namespace = await resolve(imp.specifier);
		} catch (error) {
			violations.push({
				file: imp.file,
				specifier: imp.specifier,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		const missing = imp.bindings
			.filter((binding) => !binding.typeOnly)
			.map((binding) => binding.name)
			.filter((name) => !(name in namespace));

		if (missing.length > 0) {
			violations.push({
				file: imp.file,
				specifier: imp.specifier,
				reason: `missing export(s): ${missing.join(", ")}`,
				missingBindings: missing,
			});
		}
	}

	return violations;
}
