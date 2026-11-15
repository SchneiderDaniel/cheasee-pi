// Domain: the `mod name { … }` blocks a Rust test sits in.
//
// `cargo test` prints `<module>::<function>`, so the module chain is part of a
// test's name. It is recovered from the inline `mod` blocks the function sits
// inside, not from the file path.

import { bodyEndLine } from "./inventory-braces.ts";
import { DiscoveryError } from "./inventory-parse.ts";

const MOD_HEAD = /\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;

/** One inline module block, as an inclusive line range. */
export interface ModuleScope {
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** Every `mod name { … }` block, so a test name can carry its module chain. */
export function moduleScopes(structural: readonly string[], file: string): ModuleScope[] {
	const scopes: ModuleScope[] = [];
	for (let index = 0; index < structural.length; index += 1) {
		const head = MOD_HEAD.exec(structural[index]);
		if (head === null) continue;
		const startLine = index + 1;
		const endLine = bodyEndLine(structural, startLine);
		if (endLine === null) {
			throw new DiscoveryError(file, startLine, `unterminated module body: mod ${head[1]}`);
		}
		scopes.push({ name: head[1], startLine, endLine });
	}
	return scopes;
}

/** The module names enclosing `line`, outermost first. */
export function moduleChain(scopes: readonly ModuleScope[], line: number): string[] {
	return scopes
		.filter((scope) => scope.startLine <= line && line <= scope.endLine)
		.sort((a, b) => a.startLine - b.startLine)
		.map((scope) => scope.name);
}
