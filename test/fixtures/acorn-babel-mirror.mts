// ─── CodeFlow acorn-babel function-count mirror (issue #2036) ──────
// Reproduces the branch of the pinned analyzer (`index.html`
// `Parser.extractJSFunctions`, ref below) that the browser export uses when
// `acorn` is loaded: strip TypeScript, parse the result with acorn, then walk
// the AST counting FunctionDeclaration, `const f = () =>`/`= function`,
// class/object methods and arrow-valued properties, deduplicated by
// `name@line`. This is the branch behind the issue's filed 25-file set; the
// in-gate `run-analysis.mjs` sandbox leaves `acorn` undefined and measures the
// regex branch instead, which misses object-literal methods (a mock's stubs).
//
// The analyzer strips TS with `@babel/preset-typescript` before parsing; node's
// `stripTypeScriptTypes` is the same strip step (it also preserves positions),
// so the declaration counts match the recorded acorn-babel envelope exactly.
// If acorn throws, the analyzer falls back to its regex extractor — mirrored
// here too, so the two branches cannot silently diverge.
//
// `acorn` is not a production dependency; it is the parser espree/eslint
// bundle into `node_modules`, the same one the analyzer expects to find.

import * as acorn from "acorn";
import { stripTypeScriptTypes } from "node:module";

export { ANALYZER_REF, CODE_EXTS } from "./long-file-mirror.mts";
import { CODE_EXTS } from "./long-file-mirror.mts";

type AddFn = (name: string, line: number) => void;

// The analyzer's `stripTypeScript` fallback, backed by the TS parser so complex
// annotations are handled the same way Babel's typescript preset handles them.
function stripTypeScript(src: string): string | null {
	try {
		return stripTypeScriptTypes(src, { mode: "strip" });
	} catch {
		return null;
	}
}

const EXTRACT_REGEX: Array<[RegExp, number]> = [
	[/(export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/, 2],
	[
		/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
		2,
	],
	[
		/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/,
		2,
	],
	[
		/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?function\s*[(\w]/,
		2,
	],
];

// `Parser.extractWithRegex` — the fallback the analyzer uses when the AST parse
// throws. Only the shape is mirrored; the count is what the oracle reads.
function extractWithRegex(src: string, add: AddFn): void {
	src.split("\n").forEach((line, idx) => {
		const lineNum = idx + 1;
		for (const [re, group] of EXTRACT_REGEX) {
			const m = line.match(re);
			if (m) add(m[group]!, lineNum);
		}
		let m: RegExpMatchArray | null;
		if (
			(m = line.match(/^\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/)) &&
			!line.match(/^s*(if|for|while|switch|catch|function|const|let|var)/)
		) {
			add(m[1]!, lineNum);
		}
		if ((m = line.match(/^\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s+)?function/))) {
			add(m[1]!, lineNum);
		}
		if ((m = line.match(/^\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/))) {
			add(m[1]!, lineNum);
		}
	});
}

function walk(node: unknown, add: AddFn): void {
	if (!node || typeof node !== "object") return;
	const n = node as Record<string, any>;
	if (n.type === "FunctionDeclaration" && n.id?.name) add(n.id.name, n.loc?.start.line ?? 1);
	if (n.type === "VariableDeclaration") {
		for (const decl of n.declarations ?? []) {
			const init = decl.init;
			if (
				decl.id?.type === "Identifier" &&
				(init?.type === "FunctionExpression" || init?.type === "ArrowFunctionExpression")
			) {
				add(decl.id.name, decl.loc?.start.line ?? 1);
			}
		}
	}
	if (n.type === "MethodDefinition" && n.key) {
		const name = n.key.name ?? n.key.value;
		if (name && name !== "constructor") add(name, n.loc?.start.line ?? 1);
	}
	if (n.type === "Property" && n.method && n.key) {
		const name = n.key.name ?? n.key.value;
		if (name) add(name, n.loc?.start.line ?? 1);
	}
	if (n.type === "Property" && !n.method && n.value && n.key) {
		const val = n.value;
		if (val.type === "FunctionExpression" || val.type === "ArrowFunctionExpression") {
			const name = n.key.name ?? n.key.value;
			if (name) add(name, n.loc?.start.line ?? 1);
		}
	}
	if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
		if (n.declaration) {
			walk(n.declaration, add);
			return;
		}
	}
	for (const key of Object.keys(n)) {
		if (["loc", "range", "start", "end", "raw"].includes(key)) continue;
		const child = n[key];
		if (Array.isArray(child)) child.forEach((c) => walk(c, add));
		else if (child && typeof child === "object" && child.type) walk(child, add);
	}
}

/** Count functions the way the analyzer's acorn-babel branch does. */
export function countAcornBabelFunctions(src: string, ext: string): number {
	if (!["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return -1;
	const seen = new Set<string>();
	const add: AddFn = (name, line) => seen.add(`${name}@${line}`);
	const parseContent = ext === "ts" || ext === "tsx" ? stripTypeScript(src) : src;
	let ast: acorn.Node | null = null;
	if (parseContent !== null) {
		try {
			ast = acorn.parse(parseContent, {
				ecmaVersion: 2022,
				sourceType: "module",
				allowHashBang: true,
				allowAwaitOutsideFunction: true,
				allowImportExportEverywhere: true,
				allowReturnOutsideFunction: true,
				locations: true,
			});
		} catch {
			ast = null;
		}
	}
	if (ast) walk(ast, add);
	else extractWithRegex(src, add);
	return seen.size;
}

/** The analyzer's `vbaGodFiles` predicate at an explicit ceiling. */
export function acornBabelFlagged(src: string, rel: string, ceiling: number): boolean {
	const ext = rel.split(".").pop()!;
	if (!CODE_EXTS.includes(`.${ext}`)) return false;
	return countAcornBabelFunctions(src, ext) > ceiling;
}
