// ─── Source-graph test support (issue #1866) ──────────────────────
// Parses module import/export/declaration edges from TypeScript source so
// tests can assert structural facts — which module imports what, where a
// symbol is declared — without grepping raw source text and churning on
// reformat/rename.
//
// Comments are stripped before parsing, so a commented-out import never
// counts. stdlib-only; owns no domain policy and imports no test framework.
//
// ponytail: regex parser, good enough for this repo's import style (each
// import clause uses `from`, comments are line/block). Swap for the TS
// compiler API only if exotic syntax starts being missed.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface ModuleGraph {
	/** Module paths this file imports or re-exports from. */
	specifiers: string[];
	/** Local names introduced by import clauses. */
	importedNames: string[];
	/** Targets of `export * from "<specifier>"`. */
	starReExports: string[];
	/** Exported names from `export { … }` / `export type { … }`. */
	namedReExports: string[];
	/** Names declared via interface|type|function|class|const|let|enum|namespace. */
	declarations: string[];
}

const IMPORT_FROM_RE = /^[ \t]*import\s+(?!["'])([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
const IMPORT_SIDE_EFFECT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
const STAR_REEXPORT_RE = /^[ \t]*export\s+\*\s+from\s+["']([^"']+)["']/gm;
const NAMED_REEXPORT_RE = /^[ \t]*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+["']([^"']+)["'])?/gm;
const DECLARATION_RE =
	/^[ \t]*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|function|class|const|let|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

/** Strip line and block comments (keeps everything else byte-for-byte). */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Extract local binding names from an import/export clause. */
function parseNames(clause: string): string[] {
	let c = clause.trim();
	if (c.startsWith("type ")) c = c.slice(5).trim();
	if (c.startsWith("*")) {
		const m = c.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
		return m ? [m[1]!] : [];
	}
	if (c.startsWith("{")) {
		c = c.slice(1, c.lastIndexOf("}")).trim();
		return c
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => part.split(/\s+as\s+/).pop()!.trim())
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
	}
	// default import, optionally followed by `, { … }`
	const def = c.split(",")[0]!.trim();
	return /^[A-Za-z_$][\w$]*$/.test(def) ? [def] : [];
}

/** Parse one module's import/export/declaration edges. */
export function readGraph(file: string): ModuleGraph {
	const code = stripComments(readFileSync(file, "utf-8"));
	const specifiers: string[] = [];
	const importedNames: string[] = [];

	for (const m of code.matchAll(IMPORT_FROM_RE)) {
		specifiers.push(m[2]!);
		importedNames.push(...parseNames(m[1]!));
	}
	for (const m of code.matchAll(IMPORT_SIDE_EFFECT_RE)) {
		specifiers.push(m[1]!);
	}

	const starReExports = [...code.matchAll(STAR_REEXPORT_RE)].map((m) => m[1]!);
	const namedReExports: string[] = [];
	for (const m of code.matchAll(NAMED_REEXPORT_RE)) {
		namedReExports.push(...parseNames(`{${m[1]}}`));
		if (m[2]) specifiers.push(m[2]);
	}
	const declarations = [...code.matchAll(DECLARATION_RE)].map((m) => m[2]!);

	return { specifiers, importedNames, starReExports, namedReExports, declarations };
}

/** All `.ts`/`.mts` files under dir (recursive), sorted, skipping VCS/deps. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

function normalizeSpecifier(value: string): string {
	return value.replace(/\.(mts|ts)$/, "");
}

function specifierMatches(actual: string, normalizedQuery: string): boolean {
	const a = normalizeSpecifier(actual);
	return a === normalizedQuery || a.endsWith(`/${normalizedQuery}`);
}

/** Sorted module basenames under dir that import/re-export `specifier`.
 *  Matches a full specifier ("node:child_process") or a path suffix
 *  ("config/diagnostics" against "../config/diagnostics.ts"). */
export function importersOf(dir: string, specifier: string): string[] {
	const query = normalizeSpecifier(specifier);
	return sourceFiles(dir)
		.filter((file) => readGraph(file).specifiers.some((s) => specifierMatches(s, query)))
		.map((file) => basename(file))
		.sort();
}

/** Sorted module basenames under dir that declare `name`. */
export function declarersOf(dir: string, name: string): string[] {
	return sourceFiles(dir)
		.filter((file) => readGraph(file).declarations.includes(name))
		.map((file) => basename(file))
		.sort();
}
