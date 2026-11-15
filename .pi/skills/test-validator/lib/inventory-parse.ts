// Domain: parse one source file and read the pieces the inventory needs —
// the syntax tree, exact line ranges, import statements, and the describe
// chain of a name.
//
// Fail closed: a file the parser cannot read throws `DiscoveryError` instead of
// yielding a partial scan, because a partial inventory must never reach the
// completion gate.

import { createHash } from "node:crypto";
import ts from "typescript";

/** Fail-closed discovery failure. Halts the run; never a per-test pending. */
export class DiscoveryError extends Error {
	readonly code = "DISCOVERY_FAILED";
	readonly file: string;
	readonly line: number | null;

	constructor(file: string, line: number | null, message: string) {
		super(`${file}${line === null ? "" : `:${line}`}: ${message}`);
		this.name = "DiscoveryError";
		this.file = file;
		this.line = line;
	}
}

/** TypeScript keeps parse errors on an undocumented field of `SourceFile`. */
type SourceFileWithDiagnostics = ts.SourceFile & {
	readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

function scriptKindOf(file: string): ts.ScriptKind {
	if (/\.[jt]sx$/.test(file))
		return file.endsWith("x") && file.includes(".ts") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
	return ts.ScriptKind.TS;
}

/** 1-based line number of a source position. */
export function lineOf(sf: ts.SourceFile, position: number): number {
	return sf.getLineAndCharacterOfPosition(position).line + 1;
}

/** sha256 (lowercase hex) of a string, the identity ingredient of a slice. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Exact source text of a definition's inclusive line range. */
export function sliceSource(
	source: string,
	def: { readonly startLine: number; readonly endLine: number },
): string {
	return source
		.split("\n")
		.slice(def.startLine - 1, def.endLine)
		.join("\n");
}

/**
 * Parse `source`, throwing `DiscoveryError` when the file has syntax errors.
 *
 * @param file repository-relative path, used verbatim in error messages
 * @param source file contents
 */
export function parseSourceFile(file: string, source: string): ts.SourceFile {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));

	const diagnostics = (sf as SourceFileWithDiagnostics).parseDiagnostics ?? [];
	if (diagnostics.length > 0) {
		const first = diagnostics[0];
		const line = typeof first.start === "number" ? lineOf(sf, first.start) : null;
		throw new DiscoveryError(
			file,
			line,
			`unparsable source: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
		);
	}
	return sf;
}

/** Top-level `import` statements, the judge's view of a file's dependencies. */
export function extractImports(source: string, file = "imports.ts"): string {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const lines: string[] = [];
	for (const statement of sf.statements) {
		if (ts.isImportDeclaration(statement)) {
			lines.push(statement.getText(sf));
		}
	}
	return lines.join("\n");
}
