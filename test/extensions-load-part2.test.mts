import assert from "node:assert";

import { describe, it } from "node:test";

import { readdirSync, existsSync, readFileSync } from "node:fs";

import { join, resolve } from "node:path";

import {
	extractSdkStaticImports,
	findSdkImportViolations,
	isRuntimeRelevant,
} from "./lib/sdk-import-guard.mts";

const EXTENSIONS_DIR = resolve(import.meta.dirname, "..", ".pi/extensions");

interface ExtensionEntry {
	name: string;
	dir: string;
	entryPoint: string | null;
	hasPackageJson: boolean;
	hasPackageJsonExtensions: boolean;
}

function discoverExtensions(): ExtensionEntry[] {
	if (!existsSync(EXTENSIONS_DIR)) return [];

	const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
	const extensions: ExtensionEntry[] = [];

	// Directories inside .pi/extensions/ that are shared libraries, not extensions
	const SKIP_DIRS = new Set(["lib"]);

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;

		const dir = join(EXTENSIONS_DIR, entry.name);
		const indexTs = join(dir, "index.ts");
		const indexJs = join(dir, "index.js");
		const pkgJson = join(dir, "package.json");

		const hasPkg = existsSync(pkgJson);
		let pkgExts = false;
		if (hasPkg) {
			try {
				const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
				pkgExts = !!pkg.pi?.extensions?.length;
			} catch {
				// invalid JSON — handled in manifest phase
			}
		}

		let entryPoint: string | null = null;
		if (pkgExts) {
			// Use the first declared extension path from package.json
			try {
				const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
				entryPoint = resolve(dir, pkg.pi.extensions[0]);
			} catch {
				// fall through to index.ts check
			}
		}
		if (!entryPoint && existsSync(indexTs)) entryPoint = indexTs;
		if (!entryPoint && existsSync(indexJs)) entryPoint = indexJs;

		extensions.push({
			name: entry.name,
			dir,
			entryPoint,
			hasPackageJson: hasPkg,
			hasPackageJsonExtensions: pkgExts,
		});
	}

	return extensions;
}

const SDK_SCOPE = "@earendil-works/";

function collectExtensionSources(): { file: string; source: string }[] {
	const extsDir = resolve(import.meta.dirname, "..", ".pi/extensions");
	const out: { file: string; source: string }[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "fixtures") walk(full);
			} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
				out.push({ file: full, source: readFileSync(full, "utf-8") });
			}
		}
	};
	walk(extsDir);
	return out;
}

describe("Phase 7: SDK static import resolution guard", () => {
	describe("Phase 1: detector core (pure)", () => {
		it("extracts a named SDK import exactly", () => {
			const imports = extractSdkStaticImports(
				`import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";`,
			);
			assert.strictEqual(imports.length, 1);
			assert.strictEqual(imports[0]!.specifier, "@earendil-works/pi-ai/providers/all");
			assert.deepStrictEqual(imports[0]!.bindings, [{ name: "getBuiltinModel", typeOnly: false }]);
		});

		it("ignores node:, relative and non-SDK specifiers", () => {
			const src = [
				`import { readFileSync } from "node:fs";`,
				`import { helper } from "../lib/helper.ts";`,
				`import { z } from "zod";`,
				`import { x } from "@other/pkg";`,
			].join("\n");
			assert.deepStrictEqual(extractSdkStaticImports(src), []);
		});

		it("marks statement-level type imports as typeOnly", () => {
			const imports = extractSdkStaticImports(
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			);
			assert.deepStrictEqual(imports[0]!.bindings, [{ name: "ExtensionAPI", typeOnly: true }]);
		});

		it("marks per-binding type imports in mixed clauses", () => {
			const imports = extractSdkStaticImports(`import { type A, B } from "@earendil-works/pi-ai";`);
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "A", typeOnly: true },
				{ name: "B", typeOnly: false },
			]);
		});

		it("captures side-effect imports with no bindings", () => {
			const imports = extractSdkStaticImports(`import "@earendil-works/pi-ai";`);
			assert.strictEqual(imports.length, 1);
			assert.deepStrictEqual(imports[0]!.bindings, []);
		});

		it("returns [] for empty / comment-only / whitespace sources", () => {
			assert.deepStrictEqual(extractSdkStaticImports(""), []);
			assert.deepStrictEqual(extractSdkStaticImports("   \n\t "), []);
			assert.deepStrictEqual(
				extractSdkStaticImports(`// import { getModel } from "@earendil-works/pi-ai";`),
				[],
			);
			assert.deepStrictEqual(
				extractSdkStaticImports(`/*\nimport { getModel } from "@earendil-works/pi-ai";\n*/`),
				[],
			);
		});

		it("parses a multi-line import block into one entry", () => {
			const imports = extractSdkStaticImports(
				[
					`import {`,
					`  getBuiltinModel,`,
					`  type Model,`,
					`} from "@earendil-works/pi-ai/providers/all";`,
				].join("\n"),
			);
			assert.strictEqual(imports.length, 1);
			assert.strictEqual(imports[0]!.specifier, "@earendil-works/pi-ai/providers/all");
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "getBuiltinModel", typeOnly: false },
				{ name: "Model", typeOnly: true },
			]);
		});

		it("keeps bindings that follow an inline comment in a multi-line import", async () => {
			// Regression (audit finding): a full-line-only comment stripper swallowed
			// the binding after `// primary resolver`, so a missing `getModel` drift
			// passed CI silently.
			const src = [
				`import {`,
				`  getBuiltinModel, // primary resolver`,
				`  getModel,`,
				`} from "@earendil-works/pi-ai/providers/all";`,
			].join("\n");
			const imports = extractSdkStaticImports(src);
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "getBuiltinModel", typeOnly: false },
				{ name: "getModel", typeOnly: false },
			]);

			const violations = await findSdkImportViolations(imports, () => ({
				getBuiltinModel: () => {},
			}));
			assert.strictEqual(violations.length, 1);
			assert.deepStrictEqual(violations[0]!.missingBindings, ["getModel"]);
		});

		it("ignores import-like text inside template and string literals", () => {
			// Regression (audit finding): a scanner that only strips comments
			// still sees template-literal contents, so a documentation example
			// such as this one was collected as a real import and failed CI on a
			// nonexistent named export.
			const template = [
				"const doc = `",
				`import { getModel } from "@earendil-works/pi-ai";`,
				"`;",
			].join("\n");
			assert.deepStrictEqual(extractSdkStaticImports(template), []);

			const stringLiteral = `const doc = 'import { getModel } from "@earendil-works/pi-ai";';`;
			assert.deepStrictEqual(extractSdkStaticImports(stringLiteral), []);

			// A template literal with an executable expression must not hide a
			// real import that follows it.
			const mixed = [
				"const doc = `v${1}`;",
				`import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";`,
			].join("\n");
			assert.deepStrictEqual(
				extractSdkStaticImports(mixed).map((imp) => imp.specifier),
				["@earendil-works/pi-ai/providers/all"],
			);
		});

		it("does not treat comment text as a binding", () => {
			const imports = extractSdkStaticImports(
				[
					`import {`,
					`  getBuiltinModel, // fakeComment, notARealExport`,
					`  /* getModel */`,
					`} from "@earendil-works/pi-ai/providers/all";`,
				].join("\n"),
			);
			assert.deepStrictEqual(imports[0]!.bindings, [{ name: "getBuiltinModel", typeOnly: false }]);
		});

		it("reports no violations when the resolver resolves every specifier", async () => {
			const imports = extractSdkStaticImports(
				`import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";`,
			);
			const violations = await findSdkImportViolations(imports, () => ({
				getBuiltinModel: () => {},
			}));
			assert.deepStrictEqual(violations, []);
		});

		it("reports a violation when the subpath is not exported", async () => {
			const imports = extractSdkStaticImports(
				`import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";`,
			);
			const violations = await findSdkImportViolations(imports, () => {
				throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED: no such subpath");
			});
			assert.strictEqual(violations.length, 1);
			assert.strictEqual(violations[0]!.specifier, "@earendil-works/pi-ai/providers/all");
			assert.match(violations[0]!.reason, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
		});

		it("reports a value binding missing from the resolved namespace", async () => {
			const imports = extractSdkStaticImports(`import { getModel } from "@earendil-works/pi-ai";`);
			const violations = await findSdkImportViolations(imports, () => ({ getModels: () => {} }));
			assert.strictEqual(violations.length, 1);
			assert.deepStrictEqual(violations[0]!.missingBindings, ["getModel"]);
			assert.match(violations[0]!.reason, /getModel/);
		});

		it("does not flag type-only bindings absent at runtime", async () => {
			const imports = extractSdkStaticImports(
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			);
			const violations = await findSdkImportViolations(imports, () => ({}));
			assert.deepStrictEqual(violations, []);
		});

		it("does not runtime-resolve a specifier used only by type imports", async () => {
			// Regression (audit finding): a declaration-only SDK subpath has no
			// runtime JS; resolving it would raise ERR_PACKAGE_PATH_NOT_EXPORTED
			// and fail CI on an import TypeScript erases.
			let resolveCalls = 0;
			const violations = await findSdkImportViolations(
				extractSdkStaticImports(
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
				),
				() => {
					resolveCalls += 1;
					throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED: declaration-only subpath");
				},
			);
			assert.strictEqual(resolveCalls, 0, "type-only-only specifier must not be resolved");
			assert.deepStrictEqual(violations, []);
		});

		it("does not runtime-resolve a type-only namespace import", async () => {
			// Regression (audit finding): `parseBindings` returned no bindings for
			// `* as ns`, so a type-only namespace import looked like a side-effect
			// import and was resolved — failing CI on a declaration-only subpath.
			const imports = extractSdkStaticImports(
				`import type * as SDK from "@earendil-works/pi-ai/types-only";`,
			);
			assert.strictEqual(imports.length, 1);
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "*", typeOnly: true, namespace: true },
			]);
			assert.strictEqual(
				isRuntimeRelevant(imports[0]!),
				false,
				"type-only namespace import must be treated as erased, not side-effecting",
			);

			let resolveCalls = 0;
			const violations = await findSdkImportViolations(imports, () => {
				resolveCalls += 1;
				throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED: declaration-only subpath");
			});
			assert.strictEqual(resolveCalls, 0, "type-only namespace specifier must not be resolved");
			assert.deepStrictEqual(violations, []);
		});

		it("resolves a value namespace import without inventing a missing export", async () => {
			const imports = extractSdkStaticImports(`import * as SDK from "@earendil-works/pi-ai";`);
			assert.strictEqual(isRuntimeRelevant(imports[0]!), true);
			let resolveCalls = 0;
			const violations = await findSdkImportViolations(imports, () => {
				resolveCalls += 1;
				return { getModels: () => {} };
			});
			assert.strictEqual(resolveCalls, 1, "value namespace import must be resolved");
			assert.deepStrictEqual(violations, []);
		});

		it("does not runtime-resolve imports in declaration files", async () => {
			// Regression (audit finding): `.d.ts`/`.d.mts` files are scanned but
			// never executed by Node, so a declaration-only SDK subpath used there
			// must not be runtime-resolved (that would fail CI on an erased import).
			for (const file of ["types/extension.d.ts", "types/extension.d.mts"]) {
				const imports = extractSdkStaticImports(
					`import { getModel } from "@earendil-works/pi-ai/types-only";`,
					file,
				);
				assert.strictEqual(imports.length, 1);
				assert.strictEqual(imports[0]!.erased, true);
				assert.strictEqual(
					isRuntimeRelevant(imports[0]!),
					false,
					`${file}: declaration-file import must be treated as erased`,
				);

				let resolveCalls = 0;
				const violations = await findSdkImportViolations(imports, () => {
					resolveCalls += 1;
					throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED: declaration-only subpath");
				});
				assert.strictEqual(resolveCalls, 0, `${file}: must not be runtime-resolved`);
				assert.deepStrictEqual(violations, []);
			}

			// A runtime file with the same import is still resolved (no over-erasing).
			const runtime = extractSdkStaticImports(
				`import { getModel } from "@earendil-works/pi-ai/types-only";`,
				"extension.ts",
			);
			assert.strictEqual(isRuntimeRelevant(runtime[0]!), true);
		});

		it("still resolves a specifier used by a value import alongside a type import", async () => {
			const imports = extractSdkStaticImports(
				[
					`import type { A } from "@earendil-works/pi-ai";`,
					`import { B } from "@earendil-works/pi-ai";`,
				].join("\n"),
			);
			const violations = await findSdkImportViolations(imports, () => ({}));
			assert.strictEqual(violations.length, 1);
			assert.deepStrictEqual(violations[0]!.missingBindings, ["B"]);
		});

		it("reports ERR_MODULE_NOT_FOUND without crashing", async () => {
			const imports = extractSdkStaticImports(`import { x } from "@earendil-works/pi-ai";`);
			const violations = await findSdkImportViolations(imports, () => {
				throw new Error("ERR_MODULE_NOT_FOUND: cannot find module");
			});
			assert.strictEqual(violations.length, 1);
			assert.match(violations[0]!.reason, /ERR_MODULE_NOT_FOUND/);
		});
	});
	describe("Phase 2: guard over the real extension tree", () => {
		const sources = collectExtensionSources();
		const imports = sources.flatMap(({ file, source }) => extractSdkStaticImports(source, file));
		// Runtime-resolution checks only cover specifiers a value/side-effect
		// import uses; type-only specifiers are erased and must not be resolved.
		const runtimeImports = imports.filter(isRuntimeRelevant);
		const specifiers = [...new Set(runtimeImports.map((imp) => imp.specifier))];

		it("scans a non-vacuous set of SDK imports", () => {
			assert.ok(sources.length > 0, "no extension sources scanned");
			assert.ok(imports.length > 0, "no SDK imports found");
			assert.ok(
				specifiers.length >= 4,
				`expected >= 4 distinct SDK specifiers, got ${specifiers.length}: ${specifiers.join(", ")}`,
			);
			assert.ok(
				specifiers.includes(`${SDK_SCOPE}pi-ai/providers/all`),
				"expected the providers/all import to be present in the extension tree",
			);
		});

		it("every SDK specifier resolves via dynamic import()", async () => {
			const failures: string[] = [];
			for (const specifier of specifiers) {
				try {
					await import(specifier);
				} catch (error) {
					failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			assert.deepStrictEqual(failures, [], `Unresolvable SDK specifiers:\n${failures.join("\n")}`);
		});

		it("every value binding exists in its resolved namespace", async () => {
			const cache = new Map<string, Record<string, unknown>>();
			const violations = await findSdkImportViolations(imports, async (specifier) => {
				if (!cache.has(specifier)) {
					cache.set(specifier, (await import(specifier)) as Record<string, unknown>);
				}
				return cache.get(specifier)!;
			});
			assert.deepStrictEqual(
				violations,
				[],
				`SDK import violations:\n${violations
					.map(
						(v) =>
							`${v.file} -> ${v.specifier}#${(v.missingBindings ?? ["<resolve>"]).join(",")} (${v.reason})`,
					)
					.join("\n")}`,
			);
		});

		it("pins the SDK state the issue misread", async () => {
			const all = (await import(`${SDK_SCOPE}pi-ai/providers/all`)) as Record<string, unknown>;
			assert.strictEqual(
				typeof all.getBuiltinModel,
				"function",
				"providers/all must expose getBuiltinModel",
			);
			const root = (await import(`${SDK_SCOPE}pi-ai`)) as Record<string, unknown>;
			assert.strictEqual(
				root.getModel,
				undefined,
				"root pi-ai must not expose getModel — the issue's suggested fix would break load",
			);
		});

		it("is falsifiable: flags the issue's exact stub, accepts the real import", async () => {
			const all = (await import(`${SDK_SCOPE}pi-ai/providers/all`)) as Record<string, unknown>;
			const resolver = (specifier: string) => {
				if (specifier === `${SDK_SCOPE}pi-ai/providers/all`) return all;
				throw new Error(`unexpected specifier ${specifier}`);
			};

			const broken = await findSdkImportViolations(
				extractSdkStaticImports(`import { getModel } from "@earendil-works/pi-ai/providers/all";`),
				resolver,
			);
			assert.strictEqual(broken.length, 1, "the issue's stub must be flagged");
			assert.deepStrictEqual(broken[0]!.missingBindings, ["getModel"]);

			const ok = await findSdkImportViolations(
				extractSdkStaticImports(
					`import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";`,
				),
				resolver,
			);
			assert.deepStrictEqual(ok, []);
		});
	});
});
