// Domain: scope analysis for shadowing.
//
// A call is only a test call if the identifier still resolves to the
// `node:test` binding at that point. This module answers "does any declaration
// between the call site plus the file root own this name?", so a local helper
// that happens to be called `it` is not counted as a test. Binding-name
// collection lives in `inventory-bindings.ts`.

import ts from "typescript";

import { bindingNames, importLocalNames, isNodeTestImport } from "./inventory-bindings.ts";

/**
 * Names a scope introduces. Import bindings from `node:test` are excluded:
 * they are the *definition* of the test function, not a shadow of it.
 */
function scopeDeclarations(container: ts.Node): Set<string> {
	const names = new Set<string>();

	if (
		ts.isSourceFile(container) ||
		ts.isBlock(container) ||
		ts.isModuleBlock(container) ||
		ts.isCaseClause(container) ||
		ts.isDefaultClause(container)
	) {
		for (const statement of container.statements) {
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					bindingNames(declaration.name, names);
				}
			} else if (
				ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement)
			) {
				if (statement.name) names.add(statement.name.text);
			} else if (ts.isImportDeclaration(statement) && !isNodeTestImport(statement)) {
				for (const name of importLocalNames(statement)) names.add(name);
			}
		}
		return names;
	}

	if (ts.isFunctionLike(container)) {
		for (const parameter of container.parameters) bindingNames(parameter.name, names);
		const name = (container as ts.NamedDeclaration).name;
		if (name && ts.isIdentifier(name)) names.add(name.text);
		return names;
	}

	if (ts.isCatchClause(container) && container.variableDeclaration) {
		bindingNames(container.variableDeclaration.name, names);
	}
	return names;
}

/** True if a declaration between the call site plus the file root owns `name`. */
export function isShadowed(name: string, call: ts.Node): boolean {
	let current: ts.Node | undefined = call.parent;
	while (current) {
		if (scopeDeclarations(current).has(name)) return true;
		current = current.parent;
	}
	return false;
}
