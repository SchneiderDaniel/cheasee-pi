// Domain: does a call site actually run?
//
// `it.skip(...)`, `it.todo(...)`, and `it("x", { skip: true })` never execute, so
// they are recorded as excluded instead of judged. `it.only(...)` runs, so it is
// judged like a plain `it(...)`.

import ts from "typescript";

import type { ExcludedDefinition } from "./types.ts";

/** `skip`/`todo` from the modifier chain or the options object, else null. */
export function exclusionReason(
	modifier: string | undefined,
	call: ts.CallExpression,
): ExcludedDefinition["reason"] | null {
	if (modifier === "skip") return "skip";
	if (modifier === "todo") return "todo";
	const options = call.arguments[1];
	if (!options || !ts.isObjectLiteralExpression(options)) return null;
	for (const property of options.properties) {
		if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
		const key = property.name.text;
		if (key !== "skip" && key !== "todo") continue;
		if (isEnabled(property.initializer)) return key;
	}
	return null;
}

/** `skip: true` or `skip: "reason"` switches a call site off. */
function isEnabled(value: ts.Expression): boolean {
	return value.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteral(value);
}
