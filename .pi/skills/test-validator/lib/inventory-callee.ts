// Domain: classify one call expression as a test, a describe container, or
// neither — and read what the call says about skipping.
//
// The scanner never guesses. A computed call target that names a known test
// function (`globalThis["it"](...)`) throws, because the inventory cannot tell
// whether that call site is a test.

import ts from "typescript";

import {
	DESCRIBE_FN_NAMES,
	TEST_FN_NAMES,
	TEST_MODIFIERS,
	type CallBindings,
} from "./inventory-bindings.ts";
import { DiscoveryError, lineOf } from "./inventory-parse.ts";
import { isShadowed } from "./inventory-scope.ts";

interface ResolvedCall {
	readonly kind: "test" | "describe" | "none";
	readonly modifier?: string;
}

function literalName(node: ts.Expression): string | null {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return null;
}

/** Reportable name of a call site: literal text, else the raw source argument. */
export function callName(call: ts.CallExpression, sf: ts.SourceFile): string | null {
	const arg = call.arguments[0];
	if (!arg) return null;
	return literalName(arg) ?? arg.getText(sf);
}

function elementAccessIsTest(
	callee: ts.ElementAccessExpression,
	bindings: CallBindings,
): string | null {
	const computed = literalName(callee.argumentExpression);
	if (computed === null) return null;
	const known = bindings.testFns.has(computed) || bindings.describeFns.has(computed);
	return known ? computed : null;
}

export function resolveCallee(
	call: ts.CallExpression,
	bindings: CallBindings,
	sf: ts.SourceFile,
	file: string,
): ResolvedCall {
	const callee = call.expression;

	if (ts.isIdentifier(callee)) {
		const name = callee.text;
		if (isShadowed(name, call)) return { kind: "none" };
		if (bindings.testFns.has(name)) return { kind: "test" };
		if (bindings.describeFns.has(name)) return { kind: "describe" };
		return { kind: "none" };
	}

	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		const owner = callee.expression.text;
		const member = callee.name.text;
		if (isShadowed(owner, call)) return { kind: "none" };
		if (bindings.namespaces.has(owner)) {
			if (TEST_FN_NAMES.has(member)) return { kind: "test" };
			if (DESCRIBE_FN_NAMES.has(member)) return { kind: "describe" };
			return { kind: "none" };
		}
		if (bindings.testFns.has(owner)) {
			if (TEST_MODIFIERS.has(member)) return { kind: "test", modifier: member };
			return { kind: "none" };
		}
		if (bindings.describeFns.has(owner) && TEST_MODIFIERS.has(member)) {
			return { kind: "describe" };
		}
		return { kind: "none" };
	}

	if (ts.isElementAccessExpression(callee)) {
		const computed = elementAccessIsTest(callee, bindings);
		if (computed !== null) {
			throw new DiscoveryError(
				file,
				lineOf(sf, call.getStart(sf)),
				`unresolvable ${computed} call target (computed member access); the inventory cannot decide whether this call site is a test`,
			);
		}
	}
	return { kind: "none" };
}
