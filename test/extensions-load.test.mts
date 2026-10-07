/**
 * Cross-extension smoke tests: verify all extensions load without error.
 *
 * Phase 1: Extension directory structure validation
 * Phase 2: Integration test — starts pi, checks no extension fails to load
 * Phase 3: Cross-extension conflict detection (tools, commands, flags)
 * Phase 4: Extension manifest validation
 *
 * Run with:
 *   node --experimental-strip-types --test test/extensions-load.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import {
	extractSdkStaticImports,
	findSdkImportViolations,
} from "./lib/sdk-import-guard.mts";

const EXTENSIONS_DIR = resolve(import.meta.dirname, "..", ".pi/extensions");

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────────────
// Phase 1: Extension directory structure validation
// ───────────────────────────────────────────────────────────────────────

describe("Phase 1: Extension directory structure", () => {
	const extensions = discoverExtensions();

	it("discovers at least one extension", () => {
		assert.ok(extensions.length > 0, `No extensions found in ${EXTENSIONS_DIR}`);
	});

	for (const ext of extensions) {
		it(`${ext.name}: has entry point (index.ts, index.js, or package.json -> pi.extensions)`, () => {
			assert.ok(
				ext.entryPoint !== null,
				`${ext.name}: missing entry point — need index.ts, index.js, or package.json with pi.extensions`,
			);
		});

		it(`${ext.name}: entry point exists on disk`, () => {
			if (ext.entryPoint) {
				assert.ok(
					existsSync(ext.entryPoint),
					`${ext.name}: entry point not found: ${ext.entryPoint}`,
				);
			}
		});
	}

	it("all extensions have entry points", () => {
		const missing = extensions.filter((e) => e.entryPoint === null);
		assert.strictEqual(
			missing.length,
			0,
			`Extensions missing entry points: ${missing.map((e) => e.name).join(", ")}`,
		);
	});
});

// ───────────────────────────────────────────────────────────────────────
// Phase 2: Integration test — start pi, check no extension fails to load
// ───────────────────────────────────────────────────────────────────────

describe("Phase 2: Integration — pi startup with extension loading", () => {
	it("pi --print starts without extension load errors", async () => {
		const piBin = process.env.PI_BIN || "pi";

		const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
			(resolvePromise, reject) => {
				// Use spawn (not execFile): under execFile, a pi child whose
				// startup fails with an extension load error stalls in its event
				// loop, the 30s timeout SIGTERMs it, and the "Failed to load
				// extension" line is never captured — the test silently passes
				// on a broken extension. spawn exits promptly with the full
				// stderr (verified: 1.2s to exit 1 with the error line).
				const child = spawn(piBin, ["--print", "hello"], {
					cwd: resolve(import.meta.dirname, ".."),
					env: { ...process.env },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (d: Buffer) => (stdout += d));
				child.stderr.on("data", (d: Buffer) => (stderr += d));
				const killer = setTimeout(() => {
					child.kill("SIGKILL");
				}, 30_000);
				child.on("error", (err) => {
					clearTimeout(killer);
					reject(err);
				});
				child.on("exit", () => {
					clearTimeout(killer);
					resolvePromise({ stdout, stderr });
				});
			},
		);

		// Extension loading failures appear as "Failed to load extension" on stderr
		const extLoadErrors = stderr
			.split("\n")
			.filter((line) => line.includes("Failed to load extension"));

		assert.strictEqual(
			extLoadErrors.length,
			0,
			`Found extension load errors on stderr:\n${extLoadErrors.join("\n")}`,
		);

		// Also check stdout for verbose extension loading messages
		const stdoutExtErrors = stdout
			.split("\n")
			.filter((line) => line.includes("Failed to load extension"));

		assert.strictEqual(
			stdoutExtErrors.length,
			0,
			`Found extension load errors on stdout:\n${stdoutExtErrors.join("\n")}`,
		);
	});
});

// ───────────────────────────────────────────────────────────────────────
// Phase 3: Cross-extension conflict detection
// ───────────────────────────────────────────────────────────────────────

describe("Phase 3: Cross-extension conflict detection", () => {
	const extensions = discoverExtensions();

	it("no duplicate tool names across extensions", () => {
		// Scrape tool registrations from extension source files
		const toolNames = new Map<string, string[]>(); // toolName -> extension names

		for (const ext of extensions) {
			if (!ext.entryPoint || !existsSync(ext.entryPoint)) continue;

			const content = readFileSync(ext.entryPoint, "utf-8");
			// Match pi.registerTool({  name: "..."  })
			const regex = /registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(content)) !== null) {
				const name = match[1]!;
				if (!toolNames.has(name)) toolNames.set(name, []);
				toolNames.get(name)!.push(ext.name);
			}
		}

		const duplicates = Array.from(toolNames.entries()).filter(([, exts]) => exts.length > 1);
		assert.strictEqual(
			duplicates.length,
			0,
			`Duplicate tool names found:\n${duplicates
				.map(([name, exts]) => `  "${name}" in: ${exts.join(", ")}`)
				.join("\n")}`,
		);
	});

	it("no duplicate command names across extensions", () => {
		const cmdNames = new Map<string, string[]>(); // cmd name -> extension names

		for (const ext of extensions) {
			if (!ext.entryPoint || !existsSync(ext.entryPoint)) continue;

			const content = readFileSync(ext.entryPoint, "utf-8");
			const regex = /registerCommand\s*\(\s*["']([^"']+)["']/g;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(content)) !== null) {
				const name = match[1]!;
				if (!cmdNames.has(name)) cmdNames.set(name, []);
				cmdNames.get(name)!.push(ext.name);
			}
		}

		const duplicates = Array.from(cmdNames.entries()).filter(([, exts]) => exts.length > 1);
		assert.strictEqual(
			duplicates.length,
			0,
			`Duplicate command names found:\n${duplicates
				.map(([name, exts]) => `  "${name}" in: ${exts.join(", ")}`)
				.join("\n")}`,
		);
	});

	it("no duplicate flag names across extensions", () => {
		const flagNames = new Map<string, string[]>(); // flag name -> extensions

		for (const ext of extensions) {
			if (!ext.entryPoint || !existsSync(ext.entryPoint)) continue;

			const content = readFileSync(ext.entryPoint, "utf-8");
			const regex = /registerFlag\s*\(\s*["']([^"']+)["']/g;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(content)) !== null) {
				const name = match[1]!;
				if (!flagNames.has(name)) flagNames.set(name, []);
				flagNames.get(name)!.push(ext.name);
			}
		}

		const duplicates = Array.from(flagNames.entries()).filter(([, exts]) => exts.length > 1);
		assert.strictEqual(
			duplicates.length,
			0,
			`Duplicate flag names found:\n${duplicates
				.map(([name, exts]) => `  "--${name}" in: ${exts.join(", ")}`)
				.join("\n")}`,
		);
	});
});

// ───────────────────────────────────────────────────────────────────────
// Phase 4: Extension manifest validation
// ───────────────────────────────────────────────────────────────────────

describe("Phase 4: Extension manifest validation", () => {
	const extensions = discoverExtensions();

	for (const ext of extensions) {
		it(`${ext.name}: package.json is valid JSON (if present)`, () => {
			const pkgPath = join(ext.dir, "package.json");
			if (!existsSync(pkgPath)) return; // skip — not all extensions have package.json

			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
			} catch (e) {
				assert.fail(`${ext.name}: package.json is not valid JSON: ${e}`);
			}

			assert.ok(
				typeof parsed === "object" && parsed !== null,
				`${ext.name}: package.json is not an object`,
			);
		});

		it(`${ext.name}: pi.extensions paths in package.json exist on disk`, () => {
			const pkgPath = join(ext.dir, "package.json");
			if (!existsSync(pkgPath)) return;

			let pkg: { pi?: { extensions?: string[] } };
			try {
				pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			} catch {
				return;
			}

			const piExts = pkg.pi?.extensions;
			if (!piExts?.length) return;

			for (const relPath of piExts) {
				const absPath = resolve(ext.dir, relPath);
				assert.ok(existsSync(absPath), `${ext.name}: pi.extensions path not found: ${relPath}`);
			}
		});

		it(`${ext.name}: no .js entry alongside .ts (prefer .ts)`, () => {
			const indexTs = join(ext.dir, "index.ts");
			const indexJs = join(ext.dir, "index.js");
			if (existsSync(indexTs) && existsSync(indexJs)) {
				assert.fail(`${ext.name}: has both index.ts and index.js — remove index.js`);
			}
		});
	}
});

// ───────────────────────────────────────────────────────────────────────
// Phase 5: Extension naming conventions
// ───────────────────────────────────────────────────────────────────────

describe("Phase 5: Extension naming conventions", () => {
	const extensions = discoverExtensions();

	const NAME_RE = /^[a-z][a-z0-9-]*$/;

	for (const ext of extensions) {
		it(`${ext.name}: directory name is kebab-case`, () => {
			assert.ok(
				NAME_RE.test(ext.name),
				`${ext.name}: extension dir name must be kebab-case (lowercase letters, digits, hyphens) — got "${ext.name}"`,
			);
		});
	}
});

// ───────────────────────────────────────────────────────────────────────
// Phase 6: Cross-extension imports
// ───────────────────────────────────────────────────────────────────────

describe("Phase 6: No cross-extension imports from entry-point code", () => {
	it("extensions do not import other extensions' entry-point code", () => {
		const extensions = discoverExtensions();
		const violations: string[] = [];

		// Shared library directories within extensions (allowed import targets)
		// Matches "lib/" at start or "/lib/" in middle of path
		const SHARED_LIBS = /(?:^|\/)lib\//;

		for (const ext of extensions) {
			if (!ext.entryPoint || !existsSync(ext.entryPoint)) continue;

			// Collect all .ts source files (skip node_modules, test)
			const tsFiles: string[] = [];
			const walkDir = (dir: string) => {
				if (!existsSync(dir)) return;
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						if (entry.name !== "node_modules" && entry.name !== "test") {
							walkDir(full);
						}
					} else if (
						entry.isFile() &&
						(entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))
					) {
						tsFiles.push(full);
					}
				}
			};
			walkDir(ext.dir);

			for (const file of tsFiles) {
				const content = readFileSync(file, "utf-8");
				for (const otherExt of extensions) {
					if (otherExt.name === ext.name) continue;

					// Check each import line: from "../other-ext/..."
					// but allow imports into shared lib/ directories (agent-harness/lib/)
					const importLineRe = new RegExp(`from\\s+[\"']\\.\\./${otherExt.name}/(\\S+)[\"']`, "g");
					let impMatch: RegExpExecArray | null;
					while ((impMatch = importLineRe.exec(content)) !== null) {
						const importTarget = impMatch[1]!;
						// Allow imports into shared lib/ directories
						if (SHARED_LIBS.test(importTarget)) continue;
						violations.push(`${ext.name} -> ${otherExt.name}/${importTarget} in ${file}`);
					}
				}
			}
		}

		assert.strictEqual(
			violations.length,
			0,
			`Extensions importing from other extensions (allowed: lib/):\n${violations.join("\n")}`,
		);
	});
});

// ───────────────────────────────────────────────────────────────────────
// Phase 7: SDK static import resolution guard (issue #1899)
// ───────────────────────────────────────────────────────────────────────

const SDK_SCOPE = "@earendil-works/";

/** Every .ts/.mts source under .pi/extensions (skipping fixtures/node_modules). */
function collectExtensionSources(): { file: string; source: string }[] {
	const extsDir = resolve(import.meta.dirname, "..", ".pi/extensions");
	const out: { file: string; source: string }[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "fixtures") walk(full);
			} else if (
				entry.isFile() &&
				(entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))
			) {
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
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "getBuiltinModel", typeOnly: false },
			]);
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
			const imports = extractSdkStaticImports(
				`import { type A, B } from "@earendil-works/pi-ai";`,
			);
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
			assert.deepStrictEqual(imports[0]!.bindings, [
				{ name: "getBuiltinModel", typeOnly: false },
			]);
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
		const imports = sources.flatMap(({ file, source }) =>
			extractSdkStaticImports(source).map((imp) => ({ ...imp, file })),
		);
		const specifiers = [...new Set(imports.map((imp) => imp.specifier))];

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
					failures.push(
						`${specifier}: ${error instanceof Error ? error.message : String(error)}`,
					);
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
				extractSdkStaticImports(
					`import { getModel } from "@earendil-works/pi-ai/providers/all";`,
				),
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

	describe("Phase 3: regression", () => {
		const runnerSpecifier = "../.pi/extensions/supervisor/agent/agent-session-runner.ts";
		const runnerPath = resolve(import.meta.dirname, "..", ".pi/extensions/supervisor/agent/agent-session-runner.ts");

		it("agent-session-runner.ts loads and exports runAgentInProcess", async () => {
			const mod = (await import(runnerSpecifier)) as Record<string, unknown>;
			assert.strictEqual(
				typeof mod.runAgentInProcess,
				"function",
				"agent-session-runner.ts must load and export runAgentInProcess (P0 regression)",
			);
		});

		it("production runner keeps the resolvable providers/all import", () => {
			const source = readFileSync(runnerPath, "utf-8");
			assert.match(
				source,
				/import \{ getBuiltinModel \} from "@earendil-works\/pi-ai\/providers\/all"/,
				"runner must import getBuiltinModel from providers/all",
			);
			assert.doesNotMatch(
				source,
				/import \{[^}]*\bgetModel\b[^}]*\} from "@earendil-works\/pi-ai"/,
				"runner must not import getModel from the pi-ai root (nonexistent export)",
			);
		});
	});
});
