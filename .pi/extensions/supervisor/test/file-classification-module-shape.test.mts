/**
 * Module-shape guard for `checks/file-classification.ts`.
 *
 * CodeFlow flagged this module under a "Class Modules" pattern signal. The
 * module is deliberately a plain function module: one exported pure predicate
 * over a private constant, no instance state to protect, so a class wrapper
 * would be a pass-through layer. These tests lock that shape:
 *
 * 1. the predicate contract (extensions, exclusions, boundaries),
 * 2. the `.d.ts` early return as the single exclusion point,
 * 3. the module shape itself — AST-proven: no class, exactly one export,
 *    no module-scope `let`/`var`, and a header stating the decision.
 *
 * Class detection is AST-based on purpose: a text search for "class" trips on
 * comments and on unrelated identifiers.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/file-classification-module-shape.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const testDir = dirname(fileURLToPath(import.meta.url));
const classificationPath = join(testDir, "..", "checks", "file-classification.ts");

/** Parse a TS source string for static shape analysis (no program, no checker). */
function parse(source: string, fileName = "file-classification.ts"): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every class declaration or class expression anywhere in the tree. */
function findClassNodes(sf: ts.SourceFile): ts.Node[] {
	const found: ts.Node[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(sf);
	return found;
}

/** Names of the declarations a source file exports at module scope. */
function exportedDeclarations(sf: ts.SourceFile): string[] {
	const has = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
		if (!ts.canHaveModifiers(node)) return false;
		return (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
	};
	const names: string[] = [];
	for (const stmt of sf.statements) {
		if (!has(stmt, ts.SyntaxKind.ExportKeyword)) continue;
		if (has(stmt, ts.SyntaxKind.DefaultKeyword)) {
			names.push("default");
		} else if (
			ts.isFunctionDeclaration(stmt) ||
			ts.isClassDeclaration(stmt) ||
			ts.isInterfaceDeclaration(stmt) ||
			ts.isTypeAliasDeclaration(stmt) ||
			ts.isEnumDeclaration(stmt)
		) {
			names.push(stmt.name?.text ?? "default");
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				names.push(ts.isIdentifier(decl.name) ? decl.name.text : "<pattern>");
			}
		} else if (ts.isExportDeclaration(stmt)) {
			names.push("<export-declaration>");
		} else {
			names.push("<unknown-export>");
		}
	}
	return names;
}

/** Module-scope variable statements that are not `const` (i.e. `let` / `var`). */
function mutableModuleStatements(sf: ts.SourceFile): string[] {
	return sf.statements
		.filter(ts.isVariableStatement)
		.filter((stmt) => (stmt.declarationList.flags & ts.NodeFlags.Const) === 0)
		.map((stmt) => stmt.getText(sf).split("\n")[0]);
}

/** Leading `//` comment block of a source file, joined. */
function headerComment(source: string): string {
	const lines: string[] = [];
	for (const line of source.split("\n")) {
		if (line.trim().startsWith("//")) lines.push(line);
		else if (line.trim() === "") continue;
		else break;
	}
	return lines.join("\n");
}

const moduleSource = (): string => readFileSync(classificationPath, "utf8");

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: recognized extensions — the predicate's positive contract
// ═══════════════════════════════════════════════════════════════════════

describe("isTestableFile recognized source extensions", () => {
	it("returns true for every known source extension", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const ext of ["ts", "tsx", "js", "jsx", "mts", "mjs", "py", "go", "rs", "java"]) {
			assert.equal(isTestableFile(`src/foo.${ext}`), true, `expected src/foo.${ext} testable`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: the `.d.ts` exclusion lives in the early return only
// ═══════════════════════════════════════════════════════════════════════

describe("isTestableFile type-declaration exclusion", () => {
	it("returns false for .d.ts paths at any depth", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const p of ["src/foo.d.ts", "foo.d.ts", "a/b/c.d.ts"]) {
			assert.equal(isTestableFile(p), false, `expected ${p} excluded as a declaration`);
		}
	});

	it("keeps .d.mts testable — the exclusion is .d.ts only", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(isTestableFile("x/y.d.mts"), true);
	});

	it("keeps .mts testable after the extension-stage re-check is dropped", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(isTestableFile("src/foo.mts"), true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: boundary + exclusion contract
// ═══════════════════════════════════════════════════════════════════════

describe("isTestableFile boundaries", () => {
	it("returns false for blank and whitespace-only input", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const p of ["", "   "]) {
			assert.equal(isTestableFile(p), false, `expected blank input ${JSON.stringify(p)} false`);
		}
	});

	it("returns false for paths without a recognized extension", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const p of ["Makefile", "src/foo", ".env"]) {
			assert.equal(isTestableFile(p), false, `expected ${p} not testable`);
		}
	});

	it("treats a leading-dot basename as an ordinary file name", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(isTestableFile("src/.hidden.ts"), true);
	});
});

describe("isTestableFile generated/vendor exclusions", () => {
	it("returns false for mid-path and root-relative forms", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const p of [
			"src/generated/api.ts",
			"generated/api.ts",
			"src/vendor/lib.ts",
			"vendor/lib.ts",
		]) {
			assert.equal(isTestableFile(p), false, `expected ${p} excluded`);
		}
	});
});

describe("isTestableFile barrel exclusion", () => {
	it("returns false for index files under any directory", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const base of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
			for (const dir of ["", "src/", "a/b/"]) {
				const p = `${dir}${base}`;
				assert.equal(isTestableFile(p), false, `expected barrel ${p} excluded`);
			}
		}
	});

	it("keeps index.tsx testable — not in the barrel list", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(isTestableFile("src/index.tsx"), true);
	});

	it("matches the barrel name case-sensitively", async () => {
		const { isTestableFile } = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(isTestableFile("src/Index.ts"), true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: module shape — durable answer to the "Class Modules" signal
// ═══════════════════════════════════════════════════════════════════════

describe("class detection has teeth", () => {
	it("finds class declarations and class expressions", () => {
		const synthetic = parse(
			"class Wrapper {}\nconst Anon = class {};\nexport class Named {}\n",
			"synthetic.ts",
		);
		assert.equal(findClassNodes(synthetic).length, 3);
	});

	it("does not trip on the word class inside comments or strings", () => {
		const synthetic = parse("/** no class here */\nconst s = 'class Foo';\n", "synthetic.ts");
		assert.equal(findClassNodes(synthetic).length, 0);
	});
});

describe("file-classification module shape", () => {
	it("declares no class, so the CodeFlow class-module signal has no referent", () => {
		assert.deepEqual(findClassNodes(parse(moduleSource())), []);
	});

	it("exports exactly one declaration, isTestableFile", () => {
		assert.deepEqual(exportedDeclarations(parse(moduleSource())), ["isTestableFile"]);
	});

	it("keeps SOURCE_EXTENSIONS private", () => {
		const sf = parse(moduleSource());
		const exported = exportedDeclarations(sf);
		assert.equal(
			exported.includes("SOURCE_EXTENSIONS"),
			false,
			"SOURCE_EXTENSIONS must stay private",
		);
		const declared = sf.statements
			.filter(ts.isVariableStatement)
			.flatMap((stmt) =>
				stmt.declarationList.declarations.map((d) => d.getText(sf).split(" =")[0]),
			);
		assert.ok(
			declared.some((name) => name === "SOURCE_EXTENSIONS"),
			"SOURCE_EXTENSIONS must exist",
		);
	});

	it("holds no module-scope let/var — the module stays stateless", () => {
		assert.deepEqual(mutableModuleStatements(parse(moduleSource())), []);
	});

	it("documents the plain-function decision in the module header", () => {
		assert.ok(
			headerComment(moduleSource()).includes("Module shape: plain functions"),
			"module header must state 'Module shape: plain functions'",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: the re-export shim and consumer import sites still resolve
// ═══════════════════════════════════════════════════════════════════════

describe("consumer import sites", () => {
	it("surfaces isTestableFile through the requirements-traceability shim", async () => {
		const shim = (await import("../checks/requirements-traceability.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(shim.isTestableFile("src/foo.ts"), true);
		assert.equal(shim.isTestableFile("src/foo.d.ts"), false);
	});

	it("surfaces isTestableFile through checks/requirements/index.ts", async () => {
		const index = (await import("../checks/requirements/index.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		assert.equal(index.isTestableFile("src/foo.py"), true);
	});

	it("still resolves the parity consumer, which imports the predicate directly", async () => {
		const parity = (await import("../checks/requirements/parity.ts")) as {
			checkTestFileParity?: unknown;
		};
		assert.equal(typeof parity.checkTestFileParity, "function");
	});
});
