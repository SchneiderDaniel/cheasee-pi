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
	/**
	 * Namespace clause (`* as ns`). The forged object always exists once the
	 * specifier resolves, so it has no named export to check — but it still
	 * pins whether the import is runtime-relevant.
	 */
	namespace?: boolean;
}

/** A static import of an `@earendil-works/*` specifier. */
export interface SdkStaticImport {
	specifier: string;
	bindings: SdkImportBinding[];
	/** Populated by callers that know the source file. */
	file?: string;
	/**
	 * Set for declaration files (`.d.ts`/`.d.mts`). Node never executes these,
	 * so every import in them is erased and must not be runtime-resolved.
	 */
	erased?: boolean;
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

/**
 * Pure: whether an import is resolved at runtime. Side-effect imports (no
 * bindings) and imports carrying at least one value binding are. An import
 * whose bindings are all `type`-only is erased by TypeScript, so resolving it
 * could fail on a declaration-only subpath that never loads in production.
 */
export function isRuntimeRelevant(imp: SdkStaticImport): boolean {
	if (imp.erased === true) return false;
	return imp.bindings.length === 0 || imp.bindings.some((binding) => !binding.typeOnly);
}

/** Whether a path names a declaration file, which is never executed. */
function isDeclarationFile(file?: string): boolean {
	return file !== undefined && (file.endsWith(".d.ts") || file.endsWith(".d.mts"));
}

function parseBindings(clause: ts.ImportClause | undefined): SdkImportBinding[] {
	if (clause === undefined) return []; // side-effect import: no bindings

	const statementTypeOnly = clause.isTypeOnly;
	const bindings: SdkImportBinding[] = [];

	if (clause.name !== undefined) {
		bindings.push({ name: "default", typeOnly: statementTypeOnly });
	}

	const named = clause.namedBindings;
	if (named !== undefined && ts.isNamespaceImport(named)) {
		// `* as ns` forges a namespace object; it always exists once the specifier
		// resolves, so there is no named export to check. Recorded anyway so a
		// type-only namespace import is not mistaken for a side-effect import.
		bindings.push({ name: "*", typeOnly: statementTypeOnly, namespace: true });
	}

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
 *
 * When `file` names a declaration file, its imports are marked erased: Node
 * never executes a `.d.ts`/`.d.mts`, so resolving its imports at runtime would
 * fail CI on a declaration-only subpath.
 */
export function extractSdkStaticImports(source: string, file?: string): SdkStaticImport[] {
	if (typeof source !== "string" || source.trim() === "") return [];

	const sourceFile = ts.createSourceFile(
		"extension.mts",
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	);

	const imports: SdkStaticImport[] = [];
	const erased = isDeclarationFile(file);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (specifier.startsWith(SDK_SCOPE)) {
				imports.push({ specifier, bindings: parseBindings(node.importClause), file, erased });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return imports;
}

/**
 * Pure: check each import against the namespace returned by `resolve`.
 * A specifier that fails to resolve (or a value binding absent from the
 * resolved namespace) yields one violation. Type-only imports are erased at
 * runtime and skipped entirely — resolving a declaration-only subpath would
 * otherwise fail CI on an import TypeScript never emits.
 */
export async function findSdkImportViolations(
	imports: SdkStaticImport[],
	resolve: SdkModuleResolver,
): Promise<SdkImportViolation[]> {
	const violations: SdkImportViolation[] = [];

	for (const imp of imports) {
		if (!isRuntimeRelevant(imp)) continue;

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
			.filter((binding) => !binding.typeOnly && binding.namespace !== true)
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
