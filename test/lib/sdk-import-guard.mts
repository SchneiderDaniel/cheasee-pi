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

/** Scope that a drift guard owns. */
const SDK_SCOPE = "@earendil-works/";

/** One named/default binding of a static import. */
export interface SdkImportBinding {
	/** Imported (exported) name; `"default"` for default imports. */
	name: string;
	/** `import type { X }` or `import { type X }` — erased at runtime. */
	typeOnly: boolean;
}

/** A static import of an `@earendil-works/*` specifier. */
export interface SdkStaticImport {
	specifier: string;
	bindings: SdkImportBinding[];
	/** Populated by callers that know the source file. */
	file?: string;
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
 * Static `import` statements only. `import(`/`import.meta` do not match
 * (a literal `import` keyword must be followed by whitespace/bindings), and
 * `import` only matches at statement start (after newline or `;`) so text in
 * ordinary string literals is not mistaken for an import.
 */
const STATIC_IMPORT_RE =
	/(?:^|[\n;])[ \t]*import\s+(type\s+)?(?:([\s\S]*?)\s+from\s+)?(["'])([^"']+)\3/g;

/** Full-line comments and block comments would otherwise yield phantom imports. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

function parseBindings(clause: string, statementTypeOnly: boolean): SdkImportBinding[] {
	const bindings: SdkImportBinding[] = [];
	const rest = clause.trim();
	if (rest === "") return bindings;

	// `* as ns` forges a namespace object; it always exists once the specifier
	// resolves, so there is nothing to check.
	if (/^\*\s+as\s+/.test(rest)) return bindings;

	const braceIdx = rest.indexOf("{");
	const head = (braceIdx === -1 ? rest : rest.slice(0, braceIdx)).replace(/,\s*$/, "").trim();
	const named = braceIdx === -1 ? "" : rest.slice(braceIdx);

	if (head !== "" && !/^\*\s+as\s+/.test(head)) {
		bindings.push({ name: "default", typeOnly: statementTypeOnly });
	}

	const inner = named.replace(/^\{/, "").replace(/\}$/, "");
	for (const raw of inner.split(",")) {
		const entry = raw.trim();
		if (entry === "") continue;
		const match = entry.match(/^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/);
		if (!match) continue;
		bindings.push({
			name: match[2]!,
			typeOnly: statementTypeOnly || match[1] !== undefined,
		});
	}

	return bindings;
}

/**
 * Pure: every static import of an `@earendil-works/*` specifier in `source`.
 * Non-SDK, relative, `node:` and bare non-SDK specifiers are ignored.
 */
export function extractSdkStaticImports(source: string): SdkStaticImport[] {
	if (typeof source !== "string" || source.trim() === "") return [];

	const imports: SdkStaticImport[] = [];
	const cleaned = stripComments(source);
	const re = new RegExp(STATIC_IMPORT_RE.source, STATIC_IMPORT_RE.flags);

	let match: RegExpExecArray | null;
	while ((match = re.exec(cleaned)) !== null) {
		const specifier = match[4]!;
		if (!specifier.startsWith(SDK_SCOPE)) continue;
		const statementTypeOnly = match[1] !== undefined;
		const clause = match[2] ?? "";
		imports.push({ specifier, bindings: parseBindings(clause, statementTypeOnly) });
	}

	return imports;
}

/**
 * Pure: check each import against the namespace returned by `resolve`.
 * A specifier that fails to resolve (or a value binding absent from the
 * resolved namespace) yields one violation. Type-only bindings are erased at
 * runtime and never checked.
 */
export async function findSdkImportViolations(
	imports: SdkStaticImport[],
	resolve: SdkModuleResolver,
): Promise<SdkImportViolation[]> {
	const violations: SdkImportViolation[] = [];

	for (const imp of imports) {
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
			.filter((binding) => !binding.typeOnly)
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
