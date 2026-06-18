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
import { execFile } from "node:child_process";

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
				const child = execFile(
					piBin,
					["--print", "hello"],
					{
						cwd: resolve(import.meta.dirname, ".."),
						timeout: 30_000,
						maxBuffer: 1024 * 1024,
						env: { ...process.env },
					},
					(err, stdout, stderr) => {
						if (err && !err.killed) {
							// Process may exit non-zero for many reasons (no API key, etc.)
							// We still examine stderr for extension errors.
						}
						resolvePromise({ stdout, stderr });
					},
				);
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
