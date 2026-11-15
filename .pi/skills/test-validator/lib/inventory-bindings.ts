// Domain: which local names are `node:test` bindings.
//
// Only a binding that comes from `node:test` can create a test, so a same-named
// local helper is not mistaken for one. The maps built here are the whole
// answer to "is this identifier a test function, a describe container, or a
// namespace object?".

import ts from "typescript";

/** `node:test` exports that create a runnable test. */
export const TEST_FN_NAMES: ReadonlySet<string> = new Set(["it", "test", "spec"]);
/** `node:test` exports that only group tests. */
export const DESCRIBE_FN_NAMES: ReadonlySet<string> = new Set(["describe", "suite", "context"]);
/** Members of a test function that change how the call site behaves. */
export const TEST_MODIFIERS: ReadonlySet<string> = new Set(["skip", "todo", "only"]);

const NODE_TEST_MODULE = "node:test";

export interface CallBindings {
	/** local name -> imported name for test functions. */
	readonly testFns: ReadonlyMap<string, string>;
	/** local names of describe-like containers. */
	readonly describeFns: ReadonlySet<string>;
	/** local names bound to `import * as ns from "node:test"`. */
	readonly namespaces: ReadonlySet<string>;
}

/** True when the statement imports from `node:test`. */
export function isNodeTestImport(statement: ts.ImportDeclaration): boolean {
	return (
		ts.isStringLiteral(statement.moduleSpecifier) &&
		statement.moduleSpecifier.text === NODE_TEST_MODULE
	);
}

/** Local names a single import declaration introduces. */
export function importLocalNames(statement: ts.ImportDeclaration): string[] {
	const clause = statement.importClause;
	if (!clause) return [];
	const names: string[] = [];
	if (clause.name) names.push(clause.name.text);
	const named = clause.namedBindings;
	if (!named) return names;
	if (ts.isNamespaceImport(named)) names.push(named.name.text);
	else for (const element of named.elements) names.push(element.name.text);
	return names;
}

/** Destructured/plain binding names introduced by one binding pattern. */
export function bindingNames(name: ts.BindingName, into: Set<string>): void {
	if (ts.isIdentifier(name)) {
		into.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (ts.isBindingElement(element)) bindingNames(element.name, into);
	}
}

/** Collect the `node:test` bindings of one file. */
export function collectBindings(sf: ts.SourceFile): CallBindings {
	const testFns = new Map<string, string>();
	const describeFns = new Set<string>();
	const namespaces = new Set<string>();

	for (const statement of sf.statements) {
		if (!ts.isImportDeclaration(statement) || !isNodeTestImport(statement)) continue;
		const clause = statement.importClause;
		if (!clause) continue;
		// `import nodeTest from "node:test"` is the `test` entry point itself.
		if (clause.name) testFns.set(clause.name.text, "test");
		const named = clause.namedBindings;
		if (!named) continue;
		if (ts.isNamespaceImport(named)) {
			namespaces.add(named.name.text);
			continue;
		}
		for (const element of named.elements) {
			const imported = element.propertyName ? element.propertyName.text : element.name.text;
			const local = element.name.text;
			if (TEST_FN_NAMES.has(imported)) testFns.set(local, imported);
			else if (DESCRIBE_FN_NAMES.has(imported)) describeFns.add(local);
		}
	}

	return { testFns, describeFns, namespaces };
}
