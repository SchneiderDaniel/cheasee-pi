// Domain: discovery of `node:test` call sites from source text.
//
// One inventory unit is one test call site (`it`, `test`, `spec`, and their
// `.skip`/`.todo`/`.only` forms). The scanner parses the file, reads its
// `node:test` bindings, and walks the tree tracking the describe chain. Anything
// it cannot resolve structurally (a computed call target, an unparsable file)
// throws: a partial inventory must never reach the completion gate.
//
// The pieces live in siblings so each file stays small: `inventory-parse.ts`
// (syntax tree, slices, hashes, imports), `inventory-bindings.ts` (`node:test`
// bindings), `inventory-scope.ts` (shadowing), and `inventory-callee.ts` (call
// classification).

import ts from "typescript";

import { collectBindings, type CallBindings } from "./inventory-bindings.ts";
import { callName, resolveCallee } from "./inventory-callee.ts";
import { exclusionReason } from "./inventory-exclusion.ts";
import { parseSourceFile, sha256Hex, sliceSource, lineOf } from "./inventory-parse.ts";
import type { ExcludedDefinition, InventoryResult, TestDefinition } from "./types.ts";

export { DiscoveryError, sha256Hex, sliceSource } from "./inventory-parse.ts";

/** Build one definition for a call site, with the hash of its own slice. */
function definitionFor(
	call: ts.CallExpression,
	chain: readonly string[],
	ctx: {
		readonly sf: ts.SourceFile;
		readonly source: string;
		readonly file: string;
	},
): TestDefinition | null {
	const title = callName(call, ctx.sf);
	if (title === null) return null;
	const startLine = lineOf(ctx.sf, call.getStart(ctx.sf));
	const endLine = lineOf(ctx.sf, Math.max(call.getStart(ctx.sf), call.end - 1));
	const def = { file: ctx.file, name: [...chain, title].join(" > "), startLine, endLine };
	return { ...def, sourceSha256: sha256Hex(sliceSource(ctx.source, def)) };
}

/** Walk the tree, collecting decided call sites and their exclusion reasons. */
function collectCallSites(
	sf: ts.SourceFile,
	bindings: CallBindings,
	source: string,
	file: string,
): InventoryResult {
	const tests: TestDefinition[] = [];
	const excluded: ExcludedDefinition[] = [];

	const visit = (node: ts.Node, chain: readonly string[]): void => {
		if (ts.isCallExpression(node)) {
			const resolved = resolveCallee(node, bindings, sf, file);
			if (resolved.kind === "describe") {
				const title = callName(node, sf);
				const nested = title === null ? chain : [...chain, title];
				ts.forEachChild(node, (child) => visit(child, nested));
				return;
			}
			if (resolved.kind === "test") {
				const def = definitionFor(node, chain, { sf, source, file });
				if (def) {
					const reason = exclusionReason(resolved.modifier, node);
					if (reason === null) tests.push(def);
					else excluded.push({ ...def, reason });
				}
			}
		}
		ts.forEachChild(node, (child) => visit(child, chain));
	};

	visit(sf, []);
	return { tests, excluded };
}

/**
 * Discover every `node:test` call site in `source`, with no filesystem access.
 *
 * @param source file contents
 * @param file repository-relative path, echoed verbatim into each definition
 */
export function discoverTests(source: string, file: string): InventoryResult {
	const sf = parseSourceFile(file, source);
	return collectCallSites(sf, collectBindings(sf), source, file);
}
